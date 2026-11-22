import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

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

export const byJoined = (a, b) => (a.joinedAt?.toMillis?.() ?? Date.now()) - (b.joinedAt?.toMillis?.() ?? Date.now());
