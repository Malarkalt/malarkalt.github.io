// Runs every ~10 minutes from GitHub Actions. It looks at the database and sends:
//  1. the host an email when someone asks to join,
//  2. a participant an email when they're approved,
//  3. everyone approved (and unpaid) a reminder on the due date, or when the host clicks "Send reminder now".
// Emails are decided from the database itself, so nobody can use the site to send arbitrary emails.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import nodemailer from "nodemailer";

const GMAIL_USER = process.env.GMAIL_USER || "splitlistthewebsite@gmail.com";
const { GMAIL_APP_PASSWORD, FIREBASE_SERVICE_ACCOUNT } = process.env;
const SITE = (process.env.SITE_URL || "").replace(/\/+$/, "");
const REMINDER_HOUR = 9; // send the due-date reminder from 9am in the host's time zone

if (!GMAIL_APP_PASSWORD || !FIREBASE_SERVICE_ACCOUNT || !SITE) {
  console.error("Missing GMAIL_APP_PASSWORD, FIREBASE_SERVICE_ACCOUNT or SITE_URL.");
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
const mailer = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, cur = "$") => cur + (Number(n) || 0).toFixed(2);
const prettyDate = (d) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};
function nowIn(tz) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  } catch {
    return nowIn("UTC");
  }
}

function layout(heading, bodyHtml, button) {
  return `<!doctype html><html><body style="margin:0;background:#faf7f2;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d2433">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="font-weight:800;font-size:20px;margin-bottom:16px">Split<span style="color:#0f766e">List</span></div>
    <div style="background:#fff;border:1px solid #e7e1d7;border-radius:14px;padding:24px">
      <h1 style="font-size:20px;margin:0 0 12px">${heading}</h1>
      ${bodyHtml}
      ${button ? `<p style="margin:20px 0 0"><a href="${esc(button.url)}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>` : ""}
    </div>
    <p style="color:#687082;font-size:12px;margin-top:16px">You're getting this because you're part of a SplitList gift. Your email is only used for notifications about this listing.</p>
  </div></body></html>`;
}

function payBlock(ev) {
  return `<div style="background:#faf7f2;border:1px dashed #e7e1d7;border-radius:10px;padding:12px;margin:12px 0">
    <div style="color:#687082;font-size:13px">${esc(ev.paymentType)}</div>
    <div style="font-family:Menlo,monospace;font-size:15px;word-break:break-all">${esc(ev.paymentAddress)}</div></div>`;
}

async function send(to, subject, text, html) {
  await mailer.sendMail({ from: `"SplitList" <${GMAIL_USER}>`, to, subject, text, html });
  console.log(`  ✉️  ${subject} → ${to.replace(/(.).*(@.*)/, "$1***$2")}`);
}

const hostEmails = new Map();
async function hostEmail(uid) {
  if (!hostEmails.has(uid)) {
    try { hostEmails.set(uid, (await getAuth().getUser(uid)).email || null); }
    catch { hostEmails.set(uid, null); }
  }
  return hostEmails.get(uid);
}

let failures = 0;
async function attempt(label, fn) {
  try { await fn(); } catch (e) { failures++; console.error(`  ⚠️  ${label}: ${e.message}`); }
}

const events = await db.collection("events").where("status", "==", "active").get();
console.log(`Checking ${events.size} active listing(s)…`);

for (const evDoc of events.docs) {
  const ev = { id: evDoc.id, ...evDoc.data() };
  const cur = ev.currency || "$";
  const listingUrl = `${SITE}/event.html?e=${encodeURIComponent(ev.id)}`;
  const dashUrl = `${SITE}/dashboard.html`;

  const partsSnap = await evDoc.ref.collection("participants").get();
  const parts = partsSnap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
  const approved = parts.filter((p) => p.status === "approved");
  // The host is part of the split unless they switched "Include me in the split" off.
  const people = approved.length + (ev.includeHost === false ? 0 : 1);
  const share = people ? ev.totalCost / people : ev.totalCost;
  const emailOf = async (uid) => (await evDoc.ref.collection("private").doc(uid).get()).data()?.email || null;

  // 1) New join requests → email host
  for (const p of parts.filter((x) => x.status === "pending" && x.hostNotified === false)) {
    await attempt("host notification", async () => {
      const to = await hostEmail(ev.hostUid);
      const who = await emailOf(p.id);
      if (to) {
        await send(to, `${p.name} wants to chip in on "${ev.title}"`,
          `${p.name}${who ? ` (${who})` : ""} asked to join "${ev.title}".\n\nApprove or decline them on your dashboard: ${dashUrl}`,
          layout(`New request: ${esc(p.name)}`,
            `<p><b>${esc(p.name)}</b>${who ? ` (${esc(who)})` : ""} asked to join <b>${esc(ev.title)}</b>.</p>
             <p>If you approve them, the split will be <b>${money(ev.totalCost / (people + 1), cur)}</b> each across ${people + 1} people${ev.includeHost === false ? "" : " (including you)"}.</p>`,
            { label: "Review on your dashboard", url: dashUrl }));
      }
      if (who) {
        await attempt("join confirmation", () => send(who, `Request sent: ${ev.title}`,
          `Hi ${p.name},\n\nYou asked to join "${ev.title}". The host has been notified and will approve you soon.\n\nYou can check the listing anytime (split, details and payment info) here:\n${listingUrl}\n\nSave this email so you can find the link later.`,
          layout(`Request sent, ${esc(p.name)}`,
            `<p>You asked to join <b>${esc(ev.title)}</b>. The host has been notified and will approve you soon. We'll email you when that happens.</p>
             <p>You can check the listing anytime to see the latest split, details and payment info. <b>Save this email</b> so you can always find it.</p>`,
            { label: "View the listing", url: listingUrl })));
      }
      await p.ref.update({ hostNotified: true });
    });
  }

  // 2) Newly approved → email participant
  for (const p of approved.filter((x) => x.approvedNotified === false)) {
    await attempt("approval notification", async () => {
      const to = await emailOf(p.id);
      if (to) {
        await send(to, `You're in: ${ev.title}`,
          `Hi ${p.name},\n\nThe host approved you for "${ev.title}". Your share is currently ${money(share, cur)} (split ${people} ways — it can change if more people join).\n\nPayment is due ${prettyDate(ev.dueDate)}.\nPay with: ${ev.paymentType} — ${ev.paymentAddress}\n\nSee the listing: ${listingUrl}`,
          layout(`You're in, ${esc(p.name)}! 🎉`,
            `<p>The host approved you for <b>${esc(ev.title)}</b>.</p>
             <p>Your share right now: <b style="font-size:18px">${money(share, cur)}</b><br><span style="color:#687082;font-size:13px">Split ${people} ways — this can go down if more people join.</span></p>
             <p>Payment is due <b>${prettyDate(ev.dueDate)}</b>. You'll get a reminder that day.</p>${payBlock(ev)}`,
            { label: "View the listing", url: listingUrl }));
      }
      await p.ref.update({ approvedNotified: true });
    });
  }

  // 3) Payment reminders
  const { date, hour } = nowIn(ev.timeZone || "UTC");
  const dueNow = !!ev.dueDate && (date > ev.dueDate || (date === ev.dueDate && hour >= REMINDER_HOUR));
  const sendDue = dueNow && !ev.reminderSent;
  if (sendDue || ev.remindNow) {
    const unpaid = approved.filter((p) => !p.paid);
    for (const p of unpaid) {
      await attempt("payment reminder", async () => {
        const to = await emailOf(p.id);
        if (!to) return;
        await send(to, `Time to pay: ${ev.title}`,
          `Hi ${p.name},\n\nIt's time to pay your share for "${ev.title}": ${money(share, cur)}.\nDue: ${prettyDate(ev.dueDate)}\nPay with: ${ev.paymentType} — ${ev.paymentAddress}\n\nListing: ${listingUrl}`,
          layout(`Time to pay, ${esc(p.name)}`,
            `<p>Your share for <b>${esc(ev.title)}</b> is</p>
             <p style="font-size:28px;font-weight:800;margin:4px 0 12px">${money(share, cur)}</p>
             <p>Due <b>${prettyDate(ev.dueDate)}</b>. Here's how to pay:</p>${payBlock(ev)}`,
            { label: "View the listing", url: listingUrl }));
      });
    }
    if (sendDue) {
      await attempt("host due summary", async () => {
        const to = await hostEmail(ev.hostUid);
        if (!to) return;
        const list = unpaid.map((p) => `<li>${esc(p.name)}</li>`).join("");
        await send(to, `Payment day for "${ev.title}"`,
          `Reminders were emailed to ${unpaid.length} people who haven't paid yet. Mark people as paid on your dashboard: ${dashUrl}`,
          layout(`Payment day for ${esc(ev.title)}`,
            unpaid.length
              ? `<p>We emailed a payment reminder to ${unpaid.length} ${unpaid.length === 1 ? "person" : "people"} who haven't been marked paid:</p><ul>${list}</ul><p>When money comes in, mark them as paid on your dashboard.</p>`
              : `<p>Everyone approved is already marked as paid. Nice! 🎉</p>`,
            { label: "Open dashboard", url: dashUrl }));
      });
    }
    await evDoc.ref.update({ reminderSent: ev.reminderSent || sendDue, remindNow: false });
  }
}

console.log(failures ? `Done with ${failures} failure(s).` : "Done.");
