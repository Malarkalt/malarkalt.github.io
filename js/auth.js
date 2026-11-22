import { auth, $, $$, toast, friendlyError } from "./common.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

setPersistence(auth, browserLocalPersistence).catch(() => {});

// Hosts who are already signed in go straight to their dashboard.
onAuthStateChanged(auth, (u) => {
  if (u && !u.isAnonymous) location.replace("dashboard.html");
});

const forms = { signin: $("#signinForm"), signup: $("#signupForm"), reset: $("#resetForm") };
function showForm(name) {
  Object.entries(forms).forEach(([k, f]) => f.classList.toggle("hidden", k !== name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
}
$$(".tab").forEach((t) => t.addEventListener("click", () => showForm(t.dataset.tab)));
$("#forgotBtn").addEventListener("click", () => { $("#rsEmail").value = $("#siEmail").value; showForm("reset"); });
$("#backToSignin").addEventListener("click", () => showForm("signin"));

// ---- Strong password rules ----
const rules = {
  len: (p) => p.length >= 12,
  lower: (p) => /[a-z]/.test(p),
  upper: (p) => /[A-Z]/.test(p),
  num: (p) => /[0-9]/.test(p),
  sym: (p) => /[^A-Za-z0-9]/.test(p),
};
const passwordOk = (p) => Object.values(rules).every((fn) => fn(p));
$("#suPass").addEventListener("input", (e) => {
  const p = e.target.value;
  $$("#pwChecks li").forEach((li) => li.classList.toggle("ok", rules[li.dataset.rule](p)));
});

function busy(form, on) {
  const b = form.querySelector('button[type="submit"]');
  b.disabled = on;
  if (on) { b.dataset.label = b.textContent; b.textContent = "Please wait…"; }
  else if (b.dataset.label) b.textContent = b.dataset.label;
}

forms.signin.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#siError").textContent = "";
  busy(forms.signin, true);
  try {
    await signInWithEmailAndPassword(auth, $("#siEmail").value.trim(), $("#siPass").value);
    location.replace("dashboard.html");
  } catch (err) {
    $("#siError").textContent = friendlyError(err);
    busy(forms.signin, false);
  }
});

forms.signup.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#suEmail").value.trim();
  const p1 = $("#suPass").value, p2 = $("#suPass2").value;
  const errEl = $("#suError");
  errEl.textContent = "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return (errEl.textContent = "Please enter a valid email.");
  if (!passwordOk(p1)) return (errEl.textContent = "Your password needs to meet every requirement above.");
  if (p1 !== p2) return (errEl.textContent = "Passwords don't match.");
  busy(forms.signup, true);
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, p1);
    try { await sendEmailVerification(cred.user); } catch {}
    location.replace("dashboard.html");
  } catch (err) {
    errEl.textContent = friendlyError(err);
    busy(forms.signup, false);
  }
});

forms.reset.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#rsError").textContent = "";
  busy(forms.reset, true);
  try {
    await sendPasswordResetEmail(auth, $("#rsEmail").value.trim());
    toast("If that email has an account, a reset link is on its way.");
    showForm("signin");
  } catch (err) {
    $("#rsError").textContent = friendlyError(err);
  } finally {
    busy(forms.reset, false);
  }
});
