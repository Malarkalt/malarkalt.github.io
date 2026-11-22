import {
  auth, db, $, h, money, safeUrl, formatDue, todayISO, setCookie, getCookie, toast, copyText, friendlyError, byJoined,
  hostIncluded, hostLabel, splitOf, rememberListing, forgetListing,
} from "./common.js";
import { onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, collection, onSnapshot, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const params = new URLSearchParams(location.search);
const eid = params.get("e");
// Remember the invite key for this listing in a cookie, so the page still works if reopened without it.
const key = params.get("k") || getCookie("sl_k_" + eid);
if (eid && params.get("k")) setCookie("sl_k_" + eid, params.get("k"), 180);

let uid = null;
let ev = null;
let parts = [];
let me = null;
let wasMember = false;
let withdrawing = false;
let showForm = false;
let joining = false;

const root = $("#app");
const message = (title, text) => root.replaceChildren(h("div", { class: "card" }, h("h1", {}, title), h("p", { class: "muted" }, text)));

if (!eid) {
  message("Link missing", "This link doesn't point to a listing. Ask the host to send it again.");
} else {
  // Guests are remembered with an anonymous login that the browser keeps (no password needed).
  onAuthStateChanged(auth, async (u) => {
    if (!u) {
      try { await signInAnonymously(auth); }
      catch (e) { message("Can't load listing", friendlyError(e)); }
      return;
    }
    if (uid) return;
    uid = u.uid;
    subscribe();
  });
}

function subscribe() {
  onSnapshot(doc(db, "events", eid), (s) => {
    if (!s.exists()) { message("Listing not found", "This listing may have been deleted by the host."); ev = null; return; }
    ev = { id: s.id, ...s.data() };
    document.title = ev.title + " · SplitList";
    if (me) rememberListing(eid, ev.title);
    render();
  }, (e) => message("Can't load listing", friendlyError(e)));

  onSnapshot(collection(db, "events", eid, "participants"), (s) => {
    parts = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    me = parts.find((p) => p.id === uid) || null;
    if (me) { wasMember = true; if (ev) rememberListing(eid, ev.title); }
    render();
  }, () => {});
}

// ---------- The "Add me" form (built once so typing isn't lost when the page refreshes live) ----------
const nameInput = h("input", { id: "jName", maxlength: "60", autocomplete: "name", required: true });
const emailInput = h("input", { id: "jEmail", type: "email", maxlength: "200", autocomplete: "email", required: true });
nameInput.value = getCookie("sl_name");
emailInput.value = getCookie("sl_email");
const formError = h("div", { class: "form-error" });
const submitBtn = h("button", { class: "btn big", type: "submit" }, "Ask to join");
const joinForm = h("form", { class: "card form", novalidate: true, onsubmit: onJoin },
  h("h2", {}, "Add me to this gift"),
  h("div", { class: "field" }, h("label", { for: "jName" }, "Your name"), nameInput),
  h("div", { class: "field" }, h("label", { for: "jEmail" }, "Your email"), emailInput),
  h("div", { class: "notice" }, "🔒 Your email is only used to send you notifications about this listing (approval and payment reminders). It isn't shown to other people."),
  formError,
  submitBtn,
  h("p", { class: "hint", style: "text-align:center" }, h("button", { type: "button", class: "linkbtn", onclick: () => { showForm = false; render(); } }, "Cancel")),
);

async function onJoin(e) {
  e.preventDefault();
  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  formError.textContent = "";
  if (!name) return (formError.textContent = "Please enter your name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return (formError.textContent = "Please enter a valid email.");
  joining = true; submitBtn.disabled = true; submitBtn.textContent = "Sending…";
  try {
    const b = writeBatch(db);
    b.set(doc(db, "events", eid, "participants", uid), {
      name, status: "pending", paid: false, hostNotified: false, approvedNotified: false, joinedAt: serverTimestamp(),
    });
    b.set(doc(db, "events", eid, "private", uid), { email, inviteKey: key || "" });
    await b.commit();
    setCookie("sl_name", name);
    setCookie("sl_email", email);
    rememberListing(eid, ev?.title);
    showForm = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("Request sent! The host will be emailed to approve you.");
  } catch (err) {
    formError.textContent = err?.code === "permission-denied"
      ? (ev && !ev.joinOpen
        ? "The host has closed joining for this listing."
        : "This invite link is out of date. Ask the host for the newest link.")
      : friendlyError(err);
  } finally {
    joining = false; submitBtn.disabled = false; submitBtn.textContent = "Ask to join";
  }
}

async function withdraw() {
  if (!confirm("Withdraw from this gift? You can ask to join again later if the listing is still open.")) return;
  withdrawing = true;
  try {
    const b = writeBatch(db);
    b.delete(doc(db, "events", eid, "participants", uid));
    b.delete(doc(db, "events", eid, "private", uid));
    await b.commit();
    wasMember = false;
    forgetListing(eid);
    toast("You've withdrawn.");
  } catch (e) {
    toast(friendlyError(e), "error");
  } finally {
    withdrawing = false;
    render();
  }
}

// ---------- Render ----------
function render() {
  if (!ev) return;
  const cur = ev.currency || "$";
  const approved = parts.filter((p) => p.status === "approved").sort(byJoined);
  const othersPending = parts.filter((p) => p.status === "pending" && p.id !== uid).length;
  const { people: n, share } = splitOf(ev, approved.length);
  const isPending = me?.status === "pending";
  const isApproved = me?.status === "approved";
  const myShare = isPending ? ev.totalCost / (n + 1) : share;
  const closed = ev.status !== "active";
  const today = todayISO();
  const url = safeUrl(ev.itemUrl);
  const itemName = ev.itemName || (url ? "View the item" : "");

  // Status banner at the top
  let banner = null;
  if (closed) banner = h("div", { class: "banner warn" }, h("strong", {}, "This listing is closed"), "The host has archived it.");
  else if (isPending) banner = h("div", { class: "banner warn" },
    h("strong", {}, "⏳ Waiting for the host to approve you"),
    `The host has been emailed. Once you're approved, your share will be about ${money(myShare, cur)}. We've also emailed you a link to this page so you can check back anytime.`);
  else if (isApproved) banner = h("div", { class: "banner ok" },
    h("strong", {}, `✅ You're in! Your share is ${money(share, cur)}`),
    me.paid ? "The host has marked you as paid. Thank you!" : `Please pay by ${formatDue(ev.dueDate)} using the payment info below.`);
  else if (wasMember && !withdrawing && !joining) banner = h("div", { class: "banner danger" },
    h("strong", {}, "You're no longer on this listing"), "The host declined or removed your request.");

  // People list (host first, if they're chipping in)
  const rows = [];
  if (hostIncluded(ev)) rows.push(h("li", {},
    h("div", { class: "who" }, h("b", {}, hostLabel(ev))),
    h("div", { class: "acts" }, h("span", { class: "badge accent" }, "Host"), h("span", { class: "amount" }, money(share, cur)))));
  rows.push(...approved.map((p) => h("li", { class: p.id === uid ? "me" : "" },
    h("div", { class: "who" }, h("b", {}, p.name, p.id === uid ? " (you)" : "")),
    h("div", { class: "acts" },
      p.paid ? h("span", { class: "badge ok" }, "Paid") : null,
      h("span", { class: "amount" }, money(share, cur))))));
  if (isPending) rows.push(h("li", { class: "me pending" },
    h("div", { class: "who" }, h("b", {}, me.name, " (you)"), h("small", {}, "Pending approval — not counted in the split yet")),
    h("div", { class: "acts" }, h("span", { class: "badge warn" }, "Pending"), h("span", { class: "amount" }, money(myShare, cur)))));

  // Bottom action
  let action;
  if (me) {
    action = h("div", { class: "card", style: "text-align:center" },
      h("p", { class: "muted" }, isPending ? "Changed your mind?" : "Can't chip in anymore?"),
      h("button", { class: "btn danger ghost", onclick: withdraw }, "Withdraw from this gift"));
  } else if (closed) {
    action = null;
  } else if (!ev.joinOpen) {
    action = h("div", { class: "card", style: "text-align:center" }, h("p", { class: "muted" }, "The host isn't accepting new people right now."));
  } else if (showForm) {
    action = joinForm;
  } else {
    action = h("div", { class: "card", style: "text-align:center" },
      h("p", {}, n ? `If you join, everyone's share drops to ${money(ev.totalCost / (n + 1), cur)}.` : "Be the first to chip in!"),
      h("button", { class: "btn big", onclick: () => { showForm = true; render(); nameInput.focus(); } }, "Add me"));
  }

  root.replaceChildren(
    banner,

    h("div", { class: "card" },
      h("h1", {}, ev.title),
      itemName ? h("div", { class: "hero-item" }, "🎁 ",
        url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, itemName + " ↗") : itemName) : null,
      ev.description ? h("p", { class: "pre" }, ev.description) : null,
      h("div", { class: "meta" },
        h("div", {}, h("span", { class: "muted" }, "Total"), h("b", {}, money(ev.totalCost, cur))),
        h("div", {}, h("span", { class: "muted" }, "Pay by"), h("b", {}, formatDue(ev.dueDate)),
          ev.dueDate < today && !closed ? h("span", { class: "badge danger" }, "Past due") :
          ev.dueDate === today && !closed ? h("span", { class: "badge warn" }, "Due today") : null)),
      ev.updatedAt?.toDate ? h("p", { class: "hint", style: "margin-top:1rem" },
        "Last updated " + ev.updatedAt.toDate().toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        " · this page updates live") : null),

    h("div", { class: "card" },
      h("h2", {}, "Current split"),
      n
        ? h("p", {}, h("span", { class: "split-big" }, money(share, cur)), h("span", { class: "muted" }, ` each · ${n} ${n === 1 ? "person" : "people"}`))
        : h("p", { class: "muted" }, "Nobody has been approved yet."),
      rows.length ? h("ul", { class: "people" }, rows) : null,
      othersPending ? h("p", { class: "hint" }, `+ ${othersPending} more waiting for approval`) : null),

    h("div", { class: "card" },
      h("h2", {}, "How to pay"),
      h("div", { class: "pay-box" },
        h("div", { class: "muted" }, ev.paymentType),
        h("div", { class: "row between", style: "flex-wrap:wrap" },
          h("div", { class: "addr" }, ev.paymentAddress),
          h("button", { class: "btn ghost sm", onclick: () => copyText(ev.paymentAddress) }, "Copy"))),
      isApproved ? null : h("p", { class: "hint" }, "Please wait until the host approves you before sending money, so the split is right.")),

    action,
    me ? h("p", { class: "hint", style: "text-align:center" },
      "This browser remembers you. To come back later, reopen this link, use the link in your email, or go to ",
      h("a", { href: "mine.html" }, "My gifts"), ".") : null,
  );
}
