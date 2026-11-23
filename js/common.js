import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// The address SplitList's emails come from (shown to participants so they can find them).
export const SENDER_EMAIL = "noreply@splitlist.fyi";

// Manual "Send payment reminder now" limits (the automatic due-date reminder doesn't count).
export const REMINDER_LIMITS = { day: 2, week: 3 };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny element builder. Text children are always inserted as text (never HTML), so user input is safe. */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

export function money(n, cur = "$") {
  const v = Number(n) || 0;
  return cur + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Only allow real http(s) links, so nobody can sneak a javascript: link into a listing. */
export function safeUrl(u) {
  try {
    const x = new URL(String(u).trim());
    return x.protocol === "http:" || x.protocol === "https:" ? x.href : null;
  } catch {
    return null;
  }
}

export function formatDue(d) {
  if (!d) return "—";
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, {
    weekday: "short", year: "numeric", month: "long", day: "numeric",
  });
}

export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function randomKey(len = 24) {
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => chars[b % chars.length]).join("");
}

export function setCookie(name, value, days = 365) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${days * 86400}; path=/; SameSite=Lax${secure}`;
}
export function getCookie(name) {
  const hit = document.cookie.split("; ").find((c) => c.startsWith(name + "="));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
}

// ---- "My gifts": listings this browser has joined ----
// Kept in BOTH a cookie and localStorage and merged, so one being cleared or damaged doesn't lose the list.
function parseList(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.e === "string") : [];
  } catch { return []; }
}
function readStore() {
  let ls = [];
  try { ls = parseList(localStorage.getItem("sl_mine")); } catch {}
  const seen = new Set();
  return [...parseList(getCookie("sl_mine")), ...ls].filter((x) => !seen.has(x.e) && seen.add(x.e));
}
function writeStore(list) {
  const trimmed = list.slice(0, 15).map((x) => ({ e: x.e, t: String(x.t || "").slice(0, 40) }));
  const json = JSON.stringify(trimmed);
  setCookie("sl_mine", json, 365);
  try { localStorage.setItem("sl_mine", json); } catch {}
}
export const getMyListings = () => readStore();
export function rememberListing(eid, title) {
  const list = readStore().filter((x) => x.e !== eid);
  const old = readStore().find((x) => x.e === eid);
  list.unshift({ e: eid, t: title || old?.t || "" });
  writeStore(list);
}
export function forgetListing(eid) {
  writeStore(readStore().filter((x) => x.e !== eid));
}
export const listingUrl = (eid) => {
  const u = new URL("event.html", location.href);
  u.search = "";
  u.searchParams.set("e", eid);
  return u.href;
};

let toastTimer;
export function toast(msg, kind = "") {
  let t = $("#toast");
  if (!t) { t = h("div", { id: "toast" }); document.body.append(t); }
  t.textContent = msg;
  t.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 3500);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied!"); }
  catch { toast("Couldn't copy — select it and copy manually."); }
}

export function friendlyError(e) {
  const code = e?.code || "";
  const map = {
    "auth/invalid-credential": "That email and password don't match.",
    "auth/wrong-password": "That email and password don't match.",
    "auth/user-not-found": "No account with that email.",
    "auth/email-already-in-use": "There's already an account with that email — try signing in.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/weak-password": "Please choose a stronger password.",
    "auth/password-does-not-meet-requirements": "Password doesn't meet the requirements.",
    "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
    "auth/network-request-failed": "Network problem — check your connection.",
    "permission-denied": "You don't have permission to do that.",
    "unavailable": "Can't reach the server. Check your connection.",
  };
  return map[code] || e?.message || "Something went wrong.";
}

/** The host is part of the split unless they turned "Include me in the split" off. */
export const hostIncluded = (ev) => ev.includeHost !== false;
export const hostLabel = (ev) => (ev.hostName || "").trim() || "Host";
export function splitOf(ev, approvedCount) {
  const people = approvedCount + (hostIncluded(ev) ? 1 : 0);
  return { people, share: people ? ev.totalCost / people : 0 };
}

/** A scrambled, one-way version of an email (used to stop the same email joining twice). */
export async function emailKey(email) {
  const data = new TextEncoder().encode(String(email).trim().toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Picture for a listing: the host's own upload, otherwise the item's thumbnail from its link. */
export const coverUrl = (ev) => ev?.imageData || ev?.thumbUrl || null;

export function timeAgo(date) {
  if (!date) return "";
  const sec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** How many manual reminders the host can still send (rolling 24 hours / 7 days). */
export function remindersLeft(ev) {
  const now = Date.now();
  const log = (Array.isArray(ev.reminderLog) ? ev.reminderLog : []).map(Number).filter((t) => t > now - 7 * 86400000);
  if (ev.remindNow) log.push(now); // one is already queued
  const day = log.filter((t) => t > now - 86400000).length;
  const week = log.length;
  const left = Math.max(0, Math.min(REMINDER_LIMITS.day - day, REMINDER_LIMITS.week - week));
  let nextAt = null;
  if (!left) {
    const blockers = [];
    if (day >= REMINDER_LIMITS.day) blockers.push(log.filter((t) => t > now - 86400000).sort((a, b) => a - b)[day - REMINDER_LIMITS.day] + 86400000);
    if (week >= REMINDER_LIMITS.week) blockers.push(log.sort((a, b) => a - b)[week - REMINDER_LIMITS.week] + 7 * 86400000);
    nextAt = new Date(Math.max(...blockers));
  }
  return { left, day, week, nextAt };
}

/** Shrink an uploaded photo so it fits in the database (max ~250 KB). */
export function resizeImage(file, maxSide = 900) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Please choose an image file."));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, hgt = img.naturalHeight;
      let side = maxSide;
      for (let attempt = 0; attempt < 8; attempt++) {
        const scale = Math.min(1, side / Math.max(w, hgt));
        const c = document.createElement("canvas");
        c.width = Math.round(w * scale); c.height = Math.round(hgt * scale);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const out = c.toDataURL("image/jpeg", attempt < 4 ? 0.82 - attempt * 0.1 : 0.6);
        if (out.length <= 250000) return resolve(out);
        if (attempt >= 3) side = Math.round(side * 0.75);
      }
      reject(new Error("That picture is too large. Try a smaller one."));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that picture.")); };
    img.src = url;
  });
}

export const byJoined = (a, b) => (a.joinedAt?.toMillis?.() ?? Date.now()) - (b.joinedAt?.toMillis?.() ?? Date.now());
