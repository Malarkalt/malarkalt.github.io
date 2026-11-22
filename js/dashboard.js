import {
  auth, db, $, $$, h, money, safeUrl, formatDue, todayISO, randomKey, toast, copyText, friendlyError, byJoined,
  hostIncluded, hostLabel, splitOf,
} from "./common.js";
import { onAuthStateChanged, signOut, sendEmailVerification } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, query, where, onSnapshot, writeBatch, updateDoc, getDoc, getDocs, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let user = null;
let events = [];
let filter = "active";
let current = null;        // id of the listing being viewed
let editingId = null;      // id of the listing being edited (null = creating)
let participants = [];
let emails = {};
let inviteKey;             // undefined = loading, null = missing
let detailUnsubs = [];
const counts = {};        // eventId -> { approved, pending }
const countUnsubs = {};   // eventId -> unsubscribe

// ---------- Auth ----------
onAuthStateChanged(auth, (u) => {
  if (!u || u.isAnonymous) { location.replace("index.html"); return; }
  if (user) return;
  user = u;
  $("#who").textContent = u.email;
  $("#verifyBanner").classList.toggle("hidden", u.emailVerified);

  onSnapshot(
    query(collection(db, "events"), where("hostUid", "==", u.uid)),
    (snap) => {
      events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      syncCounts();
      renderList();
      if (current) renderDetail();
    },
    (err) => toast(friendlyError(err), "error"),
  );
});

$("#signOutBtn").addEventListener("click", async () => { await signOut(auth); location.replace("index.html"); });
$("#resendVerify").addEventListener("click", async () => {
  try { await sendEmailVerification(auth.currentUser); toast("Verification email sent."); }
  catch (e) { toast(friendlyError(e), "error"); }
});

// ---------- Views ----------
function show(view) {
  ["listView", "formView", "detailView"].forEach((v) => $("#" + v).classList.toggle("hidden", v !== view));
  window.scrollTo(0, 0);
}
function stopDetail() { detailUnsubs.forEach((u) => u()); detailUnsubs = []; }
function backToList() { stopDetail(); current = null; show("listView"); }

$$("[data-filter]").forEach((t) => t.addEventListener("click", () => {
  filter = t.dataset.filter;
  $$("[data-filter]").forEach((x) => x.classList.toggle("active", x === t));
  renderList();
}));

// ---------- List ----------
function renderList() {
  const root = $("#eventList");
  const list = events
    .filter((e) => e.status === filter)
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? Date.now()) - (a.createdAt?.toMillis?.() ?? Date.now()));

  if (!list.length) {
    root.replaceChildren(h("div", { class: "empty" },
      filter === "active"
        ? [h("p", {}, "No active listings yet."), h("button", { class: "btn", onclick: openCreate }, "Create your first listing")]
        : "Nothing archived."));
    return;
  }
  root.replaceChildren(h("div", { class: "cards" }, list.map((ev) =>
    h("button", { class: "card event-card", onclick: () => openDetail(ev.id) },
      h("h3", {}, ev.title),
      h("p", { class: "muted" }, ev.itemName || "—"),
      cardStats(ev),
      h("div", { class: "row between" },
        h("span", { class: "muted" }, "Total " + money(ev.totalCost, ev.currency)),
        dueBadge(ev)),
    ))));
}

function cardStats(ev) {
  const c = counts[ev.id];
  if (!c) return h("div", { class: "card-stats muted" }, "Loading…");
  const { people, share } = splitOf(ev, c.approved);
  return h("div", { class: "card-stats" },
    h("span", {}, `👥 ${people} ${people === 1 ? "person" : "people"}`),
    h("span", { class: "amount" }, people ? money(share, ev.currency) + " each" : "—"),
    c.pending ? h("span", { class: "badge warn" }, `${c.pending} request${c.pending === 1 ? "" : "s"}`) : null);
}

// Keep a live head-count for every listing so the cards show people + split.
function syncCounts() {
  const ids = new Set(events.map((e) => e.id));
  for (const id of Object.keys(countUnsubs)) {
    if (!ids.has(id)) { countUnsubs[id](); delete countUnsubs[id]; delete counts[id]; }
  }
  for (const id of ids) {
    if (countUnsubs[id]) continue;
    countUnsubs[id] = onSnapshot(collection(db, "events", id, "participants"), (s) => {
      const ps = s.docs.map((d) => d.data());
      counts[id] = {
        approved: ps.filter((p) => p.status === "approved").length,
        pending: ps.filter((p) => p.status === "pending").length,
      };
      renderList();
    }, () => {});
  }
}

function dueBadge(ev) {
  if (ev.status === "archived") return h("span", { class: "badge" }, "Archived");
  const today = todayISO();
  if (ev.dueDate < today) return h("span", { class: "badge danger" }, "Past due");
  if (ev.dueDate === today) return h("span", { class: "badge warn" }, "Due today");
  return h("span", { class: "badge accent" }, "Due " + formatDue(ev.dueDate).replace(/^\w+, /, ""));
}

// ---------- Create / edit ----------
$("#newBtn").addEventListener("click", openCreate);
$("#formBack").addEventListener("click", formCancel);
$("#formCancel").addEventListener("click", formCancel);

function formCancel() { editingId ? openDetail(editingId) : backToList(); }

function fillForm(ev = {}) {
  $("#fTitle").value = ev.title || "";
  $("#fItemName").value = ev.itemName || "";
  $("#fItemUrl").value = ev.itemUrl || "";
  $("#fCurrency").value = ev.currency || "$";
  $("#fCost").value = ev.totalCost ?? "";
  $("#fDue").value = ev.dueDate || "";
  $("#fDesc").value = ev.description || "";
  $("#fPayType").value = ev.paymentType || "";
  $("#fPayAddr").value = ev.paymentAddress || "";
  $("#fHostName").value = ev.hostName ?? (localStorage.getItem("sl_host_name") || "");
  $("#fIncludeHost").checked = ev.id ? hostIncluded(ev) : true;
  $("#formError").textContent = "";
}

function openCreate() {
  stopDetail(); current = null; editingId = null;
  fillForm();
  $("#formTitle").textContent = "New listing";
  $("#formSubmit").textContent = "Create listing";
  show("formView");
  $("#fTitle").focus();
}

function openEdit(ev) {
  stopDetail(); editingId = ev.id;
  fillForm(ev);
  $("#formTitle").textContent = "Edit listing";
  $("#formSubmit").textContent = "Save changes";
  show("formView");
}

function readForm() {
  const data = {
    title: $("#fTitle").value.trim(),
    itemName: $("#fItemName").value.trim(),
    itemUrl: $("#fItemUrl").value.trim(),
    currency: $("#fCurrency").value.trim() || "$",
    totalCost: Math.round(parseFloat($("#fCost").value) * 100) / 100,
    dueDate: $("#fDue").value,
    description: $("#fDesc").value.trim(),
    paymentType: $("#fPayType").value.trim(),
    paymentAddress: $("#fPayAddr").value.trim(),
    hostName: $("#fHostName").value.trim().slice(0, 60),
    includeHost: $("#fIncludeHost").checked,
  };
  if (!data.title) return [null, "Give your listing a name."];
  if (data.itemUrl && !safeUrl(data.itemUrl)) return [null, "The item link should start with https://"];
  if (!(data.totalCost > 0)) return [null, "Enter the total cost."];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.dueDate)) return [null, "Pick a payment due date."];
  if (!data.paymentType || !data.paymentAddress) return [null, "Add the payment type and address so people know how to pay you."];
  return [data, null];
}

$("#eventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const [data, err] = readForm();
  if (err) { $("#formError").textContent = err; return; }
  try { if (data.hostName) localStorage.setItem("sl_host_name", data.hostName); } catch {}
  const btn = $("#formSubmit");
  btn.disabled = true;
  try {
    if (editingId) {
      const old = events.find((x) => x.id === editingId);
      const patch = { ...data, updatedAt: serverTimestamp() };
      if (old && old.dueDate !== data.dueDate) patch.reminderSent = false; // new date → new reminder
      await updateDoc(doc(db, "events", editingId), patch);
      toast("Listing updated.");
      openDetail(editingId);
    } else {
      const ref = doc(collection(db, "events"));
      const batch = writeBatch(db);
      batch.set(ref, {
        ...data,
        hostUid: user.uid,
        status: "active",
        joinOpen: true,
        reminderSent: false,
        remindNow: false,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, "events", ref.id, "secret", "invite"), { key: randomKey() });
      await batch.commit();
      toast("Listing created! Copy the invite link to share it.");
      openDetail(ref.id);
    }
  } catch (ex) {
    $("#formError").textContent = friendlyError(ex);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Detail / admin ----------
function openDetail(id) {
  stopDetail();
  current = id; editingId = null;
  participants = []; emails = {}; inviteKey = undefined;
  show("detailView");
  renderDetail();

  detailUnsubs.push(onSnapshot(collection(db, "events", id, "participants"), (s) => {
    participants = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderDetail();
  }, (e) => toast(friendlyError(e), "error")));

  detailUnsubs.push(onSnapshot(collection(db, "events", id, "private"), (s) => {
    emails = Object.fromEntries(s.docs.map((d) => [d.id, d.data().email]));
    renderDetail();
  }, () => {}));

  getDoc(doc(db, "events", id, "secret", "invite"))
    .then((d) => { if (current === id) { inviteKey = d.exists() ? d.data().key : null; renderDetail(); } })
    .catch(() => { inviteKey = null; renderDetail(); });
}

function inviteLink(ev) {
  const u = new URL("event.html", location.href);
  u.search = "";
  u.searchParams.set("e", ev.id);
  if (inviteKey) u.searchParams.set("k", inviteKey);
  return u.href;
}

function stat(label, value) {
  return h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value));
}

function itemLine(ev) {
  const url = safeUrl(ev.itemUrl);
  const name = ev.itemName || (url ? "View item" : "");
  if (!name) return null;
  return url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, name + " ↗") : name;
}

function renderDetail() {
  const root = $("#detailView");
  const ev = events.find((e) => e.id === current);
  if (!ev) { root.replaceChildren(h("p", { class: "muted" }, "Loading…")); return; }

  const cur = ev.currency || "$";
  const approved = participants.filter((p) => p.status === "approved").sort(byJoined);
  const pending = participants.filter((p) => p.status === "pending").sort(byJoined);
  const { people, share } = splitOf(ev, approved.length);
  const withHost = hostIncluded(ev);
  const paid = approved.filter((p) => p.paid);
  const paidPeople = paid.length + (withHost ? 1 : 0); // the host's own share counts as covered
  const collected = share * paidPeople;
  const pct = ev.totalCost ? Math.min(100, (collected / ev.totalCost) * 100) : 0;
  const archived = ev.status === "archived";

  root.replaceChildren(
    h("button", { class: "linkbtn back", onclick: backToList }, "← All listings"),

    h("div", { class: "row between wrapflex" },
      h("div", {}, h("h1", {}, ev.title), h("div", { class: "muted" }, itemLine(ev))),
      dueBadge(ev)),

    h("div", { class: "stats" },
      stat("Total", money(ev.totalCost, cur)),
      stat("People in", String(people)),
      stat("Each pays", people ? money(share, cur) : "—"),
      stat("Paid", `${paidPeople} / ${people}`)),
    h("div", { class: "card" },
      h("div", { class: "row between" }, h("b", {}, "Collected so far"), h("span", { class: "amount" }, `${money(collected, cur)} of ${money(ev.totalCost, cur)}`)),
      h("div", { class: "progress" }, h("div", { style: `width:${pct}%` }))),

    // Invite link
    h("div", { class: "card" },
      h("h2", {}, "Invite link"),
      archived
        ? h("p", { class: "muted" }, "This listing is archived. Unarchive it to invite people.")
        : inviteKey === undefined
          ? h("p", { class: "muted" }, "Loading…")
          : inviteKey === null
            ? h("button", { class: "btn", onclick: () => newLink(ev, false) }, "Create invite link")
            : [
              h("div", { class: "copyrow" },
                h("input", { class: "input", readonly: true, value: inviteLink(ev), onclick: (e) => e.target.select() }),
                h("button", { class: "btn", onclick: () => copyText(inviteLink(ev)) }, "Copy")),
              h("div", { class: "row wrapflex", style: "margin-top:.75rem" },
                h("button", { class: "btn ghost sm", onclick: () => toggleJoin(ev) }, ev.joinOpen ? "Close joining" : "Reopen joining"),
                h("button", { class: "btn ghost sm", onclick: () => newLink(ev, true) }, "Make a new link"),
                h("a", { class: "btn ghost sm", href: inviteLink(ev), target: "_blank", rel: "noopener" }, "Open listing page ↗")),
              h("p", { class: "hint" }, ev.joinOpen
                ? "Anyone with this link can see the listing and ask to join. You approve each person."
                : "Joining is closed — people can still view the listing, but can't ask to join."),
            ]),

    // Pending requests
    h("div", { class: "card" },
      h("h2", {}, "Join requests ", pending.length ? h("span", { class: "badge warn" }, String(pending.length)) : null),
      pending.length
        ? h("ul", { class: "people" }, pending.map((p) => h("li", {},
          h("div", { class: "who" }, h("b", {}, p.name), h("small", {}, emails[p.id] || ""), h("small", {}, "Asked " + when(p.joinedAt))),
          h("div", { class: "acts" },
            h("button", { class: "btn sm", onclick: () => setStatus(ev, p, "approved") }, "Approve"),
            h("button", { class: "btn danger ghost sm", onclick: () => removePerson(ev, p, "Decline") }, "Decline")))))
        : h("p", { class: "muted" }, "No requests right now. You'll get an email when someone asks to join.")),

    // Approved participants
    h("div", { class: "card" },
      h("h2", {}, "Participants"),
      withHost || approved.length
        ? h("ul", { class: "people" }, withHost ? h("li", { class: "me" },
          h("div", { class: "who" }, h("b", {}, hostLabel(ev), " (you)"), h("small", {}, "Host — your share counts as covered")),
          h("div", { class: "acts" }, h("span", { class: "badge accent" }, "Host"), h("span", { class: "amount" }, money(share, cur)))) : null,
          approved.map((p) => h("li", {},
          h("div", { class: "who" }, h("b", {}, p.name), h("small", {}, emails[p.id] || "")),
          h("div", { class: "acts" },
            h("span", { class: "amount" }, money(share, cur)),
            h("button", { class: p.paid ? "btn sm" : "btn ghost sm", onclick: () => togglePaid(ev, p), title: "Toggle paid" }, p.paid ? "Paid ✓" : "Mark paid"),
            h("button", { class: "btn ghost sm", onclick: () => setStatus(ev, p, "pending"), title: "Move back to requests" }, "Unapprove"),
            h("button", { class: "btn danger ghost sm", onclick: () => removePerson(ev, p, "Remove") }, "Remove")))))
        : h("p", { class: "muted" }, "Nobody approved yet.")),

    // Listing info
    h("div", { class: "card" },
      h("h2", {}, "Listing details"),
      h("p", {}, h("b", {}, "Due: "), formatDue(ev.dueDate)),
      ev.description ? h("p", { class: "pre" }, ev.description) : h("p", { class: "muted" }, "No description."),
      h("div", { class: "pay-box" },
        h("div", { class: "muted" }, ev.paymentType),
        h("div", { class: "addr" }, ev.paymentAddress))),

    // Admin actions
    h("div", { class: "card" },
      h("h2", {}, "Manage"),
      h("div", { class: "row wrapflex" },
        h("button", { class: "btn ghost", onclick: () => openEdit(ev) }, "Edit listing"),
        !archived && h("button", { class: "btn ghost", onclick: () => remindNow(ev, approved), disabled: ev.remindNow ? true : null },
          ev.remindNow ? "Reminder queued…" : "Send payment reminder now"),
        h("button", { class: "btn ghost", onclick: () => copyEmails(approved) }, "Copy participant emails"),
        h("button", { class: "btn ghost", onclick: () => toggleArchive(ev) }, archived ? "Unarchive" : "Archive"),
        h("button", { class: "btn danger ghost", onclick: () => deleteEvent(ev) }, "Delete")),
      h("p", { class: "hint" },
        ev.reminderSent
          ? "The due-date reminder has already been emailed."
          : `Everyone approved will automatically get a payment reminder on ${formatDue(ev.dueDate)}. Emails go out within about 10–15 minutes.`)),
  );
}

function when(ts) {
  const d = ts?.toDate?.();
  return d ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "just now";
}

async function run(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { toast(friendlyError(e), "error"); }
}

const setStatus = (ev, p, status) =>
  run(() => updateDoc(doc(db, "events", ev.id, "participants", p.id), { status }),
    status === "approved" ? `${p.name} approved — they'll get an email.` : `${p.name} moved back to requests.`);

const togglePaid = (ev, p) =>
  run(() => updateDoc(doc(db, "events", ev.id, "participants", p.id), { paid: !p.paid }));

function removePerson(ev, p, verb) {
  if (!confirm(`${verb} ${p.name}?`)) return;
  run(async () => {
    const b = writeBatch(db);
    b.delete(doc(db, "events", ev.id, "participants", p.id));
    b.delete(doc(db, "events", ev.id, "private", p.id));
    await b.commit();
  }, `${p.name} removed.`);
}

const toggleJoin = (ev) =>
  run(() => updateDoc(doc(db, "events", ev.id), { joinOpen: !ev.joinOpen }), ev.joinOpen ? "Joining closed." : "Joining reopened.");

function newLink(ev, askFirst) {
  if (askFirst && !confirm("Make a new invite link? The old link will still show the listing, but nobody new can join with it.")) return;
  const key = randomKey();
  run(async () => {
    await setDoc(doc(db, "events", ev.id, "secret", "invite"), { key });
    inviteKey = key;
    renderDetail();
  }, "New invite link ready.");
}

function remindNow(ev, approved) {
  const unpaid = approved.filter((p) => !p.paid);
  if (!unpaid.length) { toast("Everyone approved has already paid 🎉"); return; }
  if (!confirm(`Email a payment reminder to ${unpaid.length} ${unpaid.length === 1 ? "person who hasn't" : "people who haven't"} paid yet?`)) return;
  run(() => updateDoc(doc(db, "events", ev.id), { remindNow: true }), "Reminder queued — it'll be emailed within ~10–15 minutes.");
}

function copyEmails(approved) {
  const list = approved.map((p) => emails[p.id]).filter(Boolean);
  if (!list.length) { toast("No participant emails yet."); return; }
  copyText(list.join(", "));
}

const toggleArchive = (ev) =>
  run(() => updateDoc(doc(db, "events", ev.id), { status: ev.status === "archived" ? "active" : "archived", updatedAt: serverTimestamp() }),
    ev.status === "archived" ? "Listing is active again." : "Listing archived. Guests will see it as closed.");

async function deleteEvent(ev) {
  if (!confirm(`Permanently delete "${ev.title}" and everyone on it? This can't be undone.\n\nTip: use Archive if you just want to close it.`)) return;
  try {
    const [parts, privs] = await Promise.all([
      getDocs(collection(db, "events", ev.id, "participants")),
      getDocs(collection(db, "events", ev.id, "private")),
    ]);
    stopDetail();
    const b = writeBatch(db);
    parts.forEach((d) => b.delete(d.ref));
    privs.forEach((d) => b.delete(d.ref));
    b.delete(doc(db, "events", ev.id, "secret", "invite"));
    b.delete(doc(db, "events", ev.id));
    await b.commit();
    toast("Listing deleted.");
    backToList();
  } catch (e) {
    toast(friendlyError(e), "error");
  }
}
