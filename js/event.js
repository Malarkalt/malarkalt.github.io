import {
  auth, db, $, h, money, safeUrl, formatDue, todayISO, setCookie, getCookie, toast, copyText, friendlyError, byJoined,
  hostIncluded, hostLabel, splitOf, rememberListing, forgetListing, coverUrl, emailKey, timeAgo, SENDER_EMAIL,
} from "./common.js";
import { onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, collection, onSnapshot, writeBatch, serverTimestamp, getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const params = new URLSearchParams(location.search);
const eid = params.get("e");
// Remember the invite key for this listing in a cookie, so the page still works if reopened without it.
// (Some apps mangle "&k=" into "&amp;k=" when sharing; accept that too.)
const linkKey = (params.get("k") || params.get("amp;k") || "").trim();
const key = linkKey || getCookie("sl_k_" + eid);
if (eid && linkKey) setCookie("sl_k_" + eid, linkKey, 180);

let uid = null;
let ev = null;
let parts = [];
let me = null;
let wasMember = false;
let withdrawing = false;
let showForm = false;
let joining = false;
let lastChange = null;     // when anything on this listing last changed
let loadedEvent = false, loadedParts = false, lastSig = "";

// Note the newest change: the listing's own edit time, anyone joining or being approved/marked paid,
// and (while the page is open) anything else that changes live, like someone withdrawing.
function noteChange(date) {
  if (date && (!lastChange || date > lastChange)) lastChange = date;
}
// Keep the "Updated … ago" text fresh without redrawing the page.
setInterval(() => {
  const el = document.getElementById("lastUpdated");
  if (el && lastChange) el.textContent = "Updated " + timeAgo(lastChange);
}, 20000);

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
    noteChange(ev.updatedAt?.toDate?.());
    // Only count changes people can see (not behind-the-scenes things like the reminder log).
    const sig = JSON.stringify([ev.title, ev.itemName, ev.itemUrl, ev.totalCost, ev.currency, ev.dueDate, ev.description,
      ev.paymentType, ev.paymentAddress, ev.status, ev.joinOpen, ev.hostName, ev.includeHost, coverUrl(ev)]);
    if (loadedEvent && sig !== lastSig) noteChange(new Date());
    lastSig = sig;
    loadedEvent = true;
    if (me) rememberListing(eid, ev.title);
    render();
  }, (e) => message("Can't load listing", friendlyError(e)));

  onSnapshot(collection(db, "events", eid, "participants"), (s) => {
    parts = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    me = parts.find((p) => p.id === uid) || null;
    for (const p of parts) { noteChange(p.joinedAt?.toDate?.()); noteChange(p.updatedAt?.toDate?.()); }
    if (loadedParts && s.docChanges().length) noteChange(new Date());
    loadedParts = true;
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
    const k = await emailKey(email);
    const b = writeBatch(db);
    b.set(doc(db, "events", eid, "participants", uid), {
      name, status: "pending", paid: false, hostNotified: false, approvedNotified: false, joinedAt: serverTimestamp(),
    });
    b.set(doc(db, "events", eid, "private", uid), { email, inviteKey: key || "", emailKey: k });
    b.set(doc(db, "events", eid, "emails", k), { uid }); // one email = one spot on this listing
    await b.commit();
    setCookie("sl_name", name);
    setCookie("sl_email", email);
    rememberListing(eid, ev?.title);
    showForm = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("Request sent! The host will be emailed to approve you.");
  } catch (err) {
    formError.replaceChildren(err?.code === "permission-denied"
      ? (ev && !ev.joinOpen
        ? "The host has closed joining for this listing."
        : h("span", {},
          h("b", {}, "We couldn't add you. "),
          "Either this email is already on this listing (check your confirmation email, or ",
          h("a", { href: "mine.html" }, "My gifts"),
          " on the phone or browser you joined from), or the host has made a new invite link since this one was sent. If so, ask the host for the newest link.",
          h("br", {}), h("small", { class: "muted" }, `Details: ${err?.code || "error"} · code ${linkKey ? "in link" : key ? "saved" : "missing"} · ${navigator.userAgent.match(/(Discord|Instagram|FBAN|FBAV|Snapchat|TikTok|Line|CriOS|FxiOS|EdgiOS|Chrome|Safari)/)?.[1] || "browser"}`)))
      : friendlyError(err));
  } finally {
    joining = false; submitBtn.disabled = false; submitBtn.textContent = "Ask to join";
  }
}

async function withdraw() {
  if (!confirm("Withdraw from this gift? You can ask to join again later if the listing is still open.")) return;
  withdrawing = true;
  try {
    let k = null;
    try { k = (await getDoc(doc(db, "events", eid, "private", uid))).data()?.emailKey || null; } catch {}
    const b = writeBatch(db);
    b.delete(doc(db, "events", eid, "participants", uid));
    b.delete(doc(db, "events", eid, "private", uid));
    if (k) b.delete(doc(db, "events", eid, "emails", k));
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
    h("p", { style: "margin:0 0 .5rem" }, `The host has been emailed. Once you're approved, your share will be about ${money(myShare, cur)}.`),
    h("p", { style: "margin:0" }, "📧 A confirmation email from ", h("b", {}, `SplitList (${SENDER_EMAIL})`),
      " has been sent to you with a link back to this listing. It can take up to 15 minutes and is most likely in your ",
      h("b", {}, "spam or junk folder"), ". Mark it as \"Not spam\" so you also get the approval and payment reminder emails."));
  else if (isApproved) banner = h("div", { class: "banner ok" },
    h("strong", {}, `✅ You're in! Your share is ${money(share, cur)}`),
    me.paid ? "The host has marked you as paid. Thank you!" : `Please pay by ${formatDue(ev.dueDate)} using the payment info below.`,
    h("p", { style: "margin:.5rem 0 0" }, "📧 A confirmation email from ", h("b", {}, `SplitList (${SENDER_EMAIL})`),
      " has been sent to you with a link back to this listing. It can take up to 15 minutes and is most likely in your ",
      h("b", {}, "spam or junk folder"), ". Mark it as \"Not spam\" so you also get the payment reminder."));
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
  } else if (!key) {
    action = h("div", { class: "card", style: "text-align:center" },
      h("p", {}, h("b", {}, "This link can only be used to view the listing.")),
      h("p", { class: "muted", style: "margin:0" }, "To join, ask the host to send you the invite link from their dashboard."));
  } else if (showForm) {
    action = joinForm;
  } else {
    action = h("div", { class: "card", style: "text-align:center" },
      h("p", {}, n ? `If you join, everyone's share drops to ${money(ev.totalCost / (n + 1), cur)}.` : "Be the first to chip in!"),
      h("button", { class: "btn big", onclick: () => { showForm = true; render(); nameInput.focus(); } }, "Add me"));
  }

  root.replaceChildren(...[
    banner,

    h("div", { class: "card" },
      coverUrl(ev) ? h("img", { class: "cover", src: coverUrl(ev), alt: ev.itemName || ev.title, referrerpolicy: "no-referrer", onerror: (e) => e.target.remove() }) : null,
      h("h1", {}, ev.title),
      itemName ? h("div", { class: "hero-item" }, "🎁 ",
        url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, itemName + " ↗") : itemName) : null,
      ev.description ? h("p", { class: "pre" }, ev.description) : null,
      h("div", { class: "meta" },
        h("div", {}, h("span", { class: "muted" }, "Total"), h("b", {}, money(ev.totalCost, cur))),
        h("div", {}, h("span", { class: "muted" }, "Pay by"), h("b", {}, formatDue(ev.dueDate)),
          ev.dueDate < today && !closed ? h("span", { class: "badge danger" }, "Past due") :
          ev.dueDate === today && !closed ? h("span", { class: "badge warn" }, "Due today") : null)),
      lastChange ? h("p", { class: "hint", style: "margin-top:1rem" },
        h("span", { id: "lastUpdated", title: lastChange.toLocaleString() }, "Updated " + timeAgo(lastChange)),
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
  ].filter(Boolean));  // skip empty parts so the page never shows "null"
}
