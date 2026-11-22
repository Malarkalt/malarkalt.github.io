import { db, $, h, money, splitOf, getMyListings, forgetListing, listingUrl } from "./common.js";
import { doc, getDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const list = $("#mineList");
const mine = getMyListings();

function showEmpty() {
  list.replaceChildren(h("li", { class: "muted", style: "display:block" },
    "No gifts on this browser yet. When you tap \"Add me\" on a gift's invite link, it will show up here."));
}

if (!mine.length) {
  showEmpty();
} else {
  list.replaceChildren(...mine.map((m) => {
    const li = h("li", {},
      h("div", { class: "who" }, h("b", {}, m.t || "Gift listing"), h("small", { class: "status" }, "Loading…")),
      h("div", { class: "acts" }, h("a", { class: "btn sm", href: listingUrl(m.e) }, "Open")));
    loadOne(m, li);
    return li;
  }));
}

async function loadOne(m, li) {
  const status = li.querySelector(".status");
  try {
    const s = await getDoc(doc(db, "events", m.e));
    if (!s.exists()) {
      forgetListing(m.e);
      li.remove();
      if (!list.children.length) showEmpty();
      return;
    }
    const ev = s.data();
    li.querySelector("b").textContent = ev.title;
    const parts = await getDocs(collection(db, "events", m.e, "participants"));
    const approved = parts.docs.filter((d) => d.data().status === "approved").length;
    const { people, share } = splitOf(ev, approved);
    status.textContent = ev.status === "archived"
      ? "Closed by the host"
      : `${people} ${people === 1 ? "person" : "people"} · ${money(share, ev.currency || "$")} each`;
  } catch {
    status.textContent = "";
  }
}
