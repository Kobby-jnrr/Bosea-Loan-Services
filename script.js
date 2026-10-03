"use strict";

/* ==========================================================================
   LOAN CONFIGURATION  -  edit values here; everything else is calculated.
   Estimates only; the loan agreement is the final authority.
   ========================================================================== */
const LOAN_CONFIG = {
  currency: "GHS",
  principal: 1500, // original principal
  initialRate: 0.0934, // 9.34% one-time interest on the original principal
  tenureDays: 52, // initial tenure in calendar days
  startDate: "2026-07-24", // YYYY-MM-DD (loan start / disbursement)
  monthlyRate: 0.054, // 5.4% of the ORIGINAL principal per month after tenure
  /* SCHEDULING RULE (change if your contract differs):
     - Tenure ends `tenureDays` calendar days after startDate.
     - First monthly charge falls `firstChargeMonthsAfterTenure` month(s) after the tenure end date (0 = on the tenure end date).
     - Later charges fall on each monthly anniversary of the tenure end day.
     - If a month is too short, the last day of that month is used.
     - A charge counts only if its date is on or before the calculation date.
     - No proration for partial months, no compounding. */
  firstChargeMonthsAfterTenure: 0, // 0 = first 5.4% fee is charged on the tenure end date itself (14 Sep 2026); 1 = one month later
  /* OTHER CHARGES (none by default - add only contractual fees you actually know).
     Example: { label: "Admin fee", amount: 20, date: "2026-10-01" }
     A charge counts once, only when its date is on or before the calculation date. */
  otherCharges: [],
};
const STORAGE_KEY = "demoLoanRepayments_v1";
const MAX_CHARGES = 600; // safety limit for the schedule loop

/* ---------- Date helpers: all dates are UTC midnight to avoid timezone shifts ---------- */
const DAY_MS = 86400000;
function parseISO(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || "");
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 ? d : null; // rejects e.g. 2026-02-31
}
function toISO(d) {
  return d.toISOString().slice(0, 10);
}
function todayUTC() {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}
function addDays(d, n) {
  return new Date(d.getTime() + n * DAY_MS);
}
/* Add n months, keeping anchorDay; clamp to the last day of short months. */
function addMonths(d, n, anchorDay) {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const y = Math.floor(total / 12),
    mo = total % 12;
  const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, mo, Math.min(anchorDay, dim)));
}
const fmtLong = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const fmtShort = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

/* ---------- Money helpers ---------- */
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const moneyFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const money = (n) => `${LOAN_CONFIG.currency} ${moneyFmt.format(round2(n))}`;
const pct = (r) => `${+(r * 100).toFixed(2)}%`;

/* ---------- Core calculations ---------- */
const START = parseISO(LOAN_CONFIG.startDate);
const TENURE_END = addDays(START, LOAN_CONFIG.tenureDays);
const ANCHOR_DAY = TENURE_END.getUTCDate();
const INITIAL_INTEREST = round2(
  LOAN_CONFIG.principal * LOAN_CONFIG.initialRate,
); // Principal x Initial Rate
const INITIAL_AMOUNT = round2(LOAN_CONFIG.principal + INITIAL_INTEREST); // Principal + Initial Interest
const MONTHLY_INTEREST = round2(
  LOAN_CONFIG.principal * LOAN_CONFIG.monthlyRate,
); // Principal x Monthly Rate (never the balance)

/* Date of the n-th (0-based) monthly post-tenure charge. */
function chargeDate(n) {
  return addMonths(
    TENURE_END,
    LOAN_CONFIG.firstChargeMonthsAfterTenure + n,
    ANCHOR_DAY,
  );
}
/* All charge dates on or before `until`. */
function chargesUpTo(until) {
  const list = [];
  for (let i = 0; i < MAX_CHARGES; i++) {
    const d = chargeDate(i);
    if (d > until) break;
    list.push(d);
  }
  return list;
}

/* Full position at `calcDate`:
   Balance = Principal + Initial Interest + (charges x monthly fee) + other charges - repayments.
   Initial interest is added once; the monthly fee always uses the ORIGINAL principal; no compounding. */
function computePosition(calcDate, extraRepaid) {
  const charges = chargesUpTo(calcDate).length;
  const postTenureInterest = round2(charges * MONTHLY_INTEREST);
  const otherTotal = round2(
    LOAN_CONFIG.otherCharges
      .filter((c) => parseISO(c.date) <= calcDate)
      .reduce((s, c) => s + c.amount, 0),
  );
  const totalDue = round2(INITIAL_AMOUNT + postTenureInterest + otherTotal);
  const recorded = round2(
    state.repayments
      .filter((r) => parseISO(r.date) <= calcDate)
      .reduce((s, r) => s + r.amount, 0),
  );
  const repaid = round2(recorded + extraRepaid);
  const balance = round2(Math.max(totalDue - repaid, 0)); // never negative
  const excess = round2(Math.max(repaid - totalDue, 0)); // overpayment shown separately
  return {
    charges,
    postTenureInterest,
    otherTotal,
    totalDue,
    recorded,
    repaid,
    balance,
    excess,
  };
}

/* ---------- State & storage ---------- */
const state = {
  calcDate: todayUTC(),
  extraRepaid: 0,
  repayments: loadRepayments(),
};

function loadRepayments() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(data)
      ? data.filter((r) => r && parseISO(r.date) && r.amount > 0)
      : [];
  } catch (e) {
    return [];
  }
}
function saveRepayments() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.repayments));
  } catch (e) {
    /* storage unavailable */
  }
}

/* ---------- DOM helpers ---------- */
const $ = (id) => document.getElementById(id);
const setText = (id, t) => {
  $(id).textContent = t;
};
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/* ---------- Rendering ---------- */
/* Copy each column heading into data-label on the cells so tables can stack as cards on phones. */
function applyLabels(tbodyId) {
  const heads = [
    ...$(tbodyId).closest("table").querySelectorAll("thead th"),
  ].map((t) => t.textContent);
  $(tbodyId)
    .querySelectorAll("tr")
    .forEach((tr) =>
      [...tr.children].forEach((td, i) => {
        if (!td.classList.contains("empty") && heads[i])
          td.dataset.label = heads[i];
      }),
    );
}

function renderStatic() {
  const L = LOAN_CONFIG;
  setText("dPrincipal", money(L.principal));
  setText("dStart", fmtShort.format(START));
  setText("dRate", pct(L.initialRate));
  setText("dTenure", `${L.tenureDays} days`);
  setText("dEnd", fmtLong.format(TENURE_END));
  setText("dFirst", fmtLong.format(chargeDate(0)));
  setText(
    "dMonthlyRate",
    `${pct(L.monthlyRate)} of original principal (${money(MONTHLY_INTEREST)} per month)`,
  );
  setText(
    "cInterest",
    `${money(L.principal)} × ${pct(L.initialRate)} = ${money(INITIAL_INTEREST)}`,
  );
  setText(
    "cInitial",
    `${money(L.principal)} + ${money(INITIAL_INTEREST)} = ${money(INITIAL_AMOUNT)}`,
  );
  setText(
    "cMonthly",
    `${money(L.principal)} × ${pct(L.monthlyRate)} = ${money(MONTHLY_INTEREST)}`,
  );
  setText("kPrincipal", money(L.principal));
  setText("kInterest", money(INITIAL_INTEREST));
  setText("bdPrincipal", money(L.principal));
  setText("bdInterest", money(INITIAL_INTEREST));
}

function renderAll() {
  const p = computePosition(state.calcDate, state.extraRepaid);
  renderSummary(p);
  renderResults(p);
  renderChart(p);
  renderTimeline();
  renderHistory();
}

function renderSummary(p) {
  const asOf = fmtLong.format(state.calcDate);
  setText("sumBalance", money(p.balance));
  setText("sumAsOf", `Calculated as of ${asOf}`);
  setText(
    "sumExcess",
    p.excess > 0 ? `Excess payment: ${money(p.excess)}` : "",
  );
  setText("bdFees", money(p.postTenureInterest));
  setText("bdOther", money(p.otherTotal));
  setText("bdRepaid", `- ${money(p.repaid)}`);
  setText("bdFinal", money(p.balance));
  setText("kFees", money(p.postTenureInterest));
  setText(
    "kFeesNote",
    `${p.charges} monthly charge${p.charges === 1 ? "" : "s"} × ${money(MONTHLY_INTEREST)}`,
  );
  setText("kRepaid", money(p.repaid));
  setText("dCalc", asOf);
  setText("dCharges", String(p.charges));
}

function renderResults(p) {
  const rows = [
    ["Original principal", money(LOAN_CONFIG.principal)],
    ["Initial interest", money(INITIAL_INTEREST)],
    ["Original loan amount incl. initial interest", money(INITIAL_AMOUNT)],
    ["Monthly post-tenure charges applicable", String(p.charges)],
    ["Total post-tenure interest accrued", money(p.postTenureInterest)],
    ["Other configured charges", money(p.otherTotal)],
    ["Total amount due before repayments", money(p.totalDue)],
    ["Total amount already repaid", money(p.repaid)],
    ["Estimated outstanding balance", money(p.balance), true],
  ];
  if (p.excess > 0) rows.push(["Excess payment", money(p.excess), true]);
  const box = $("results");
  box.replaceChildren();
  rows.forEach(([k, v, hl]) => {
    const d = el("div", undefined, hl ? "highlight" : "");
    d.append(el("dt", k), el("dd", v));
    box.append(d);
  });
}

function renderChart(p) {
  const parts = [
    ["Original principal", LOAN_CONFIG.principal, "#1f2430"],
    ["Initial interest", INITIAL_INTEREST, "#b98600"],
    ["Accumulated post-tenure fees", p.postTenureInterest, "#f59e0b"],
    ["Total repayments", p.repaid, "#15803d"],
  ];
  const max = Math.max(p.totalDue, p.repaid, 1);
  const box = $("bars");
  box.replaceChildren();
  parts.forEach(([name, val, color]) => {
    const row = el("div", undefined, "bar-row");
    const lab = el("div", undefined, "bar-label");
    lab.append(
      el("span", name),
      el("span", `${money(val)} (${((val / max) * 100).toFixed(1)}%)`),
    );
    const track = el("div", undefined, "bar-track");
    const fill = el("div", undefined, "bar-fill");
    fill.style.width = `${(val / max) * 100}%`;
    fill.style.background = color;
    track.append(fill);
    row.append(lab, track);
    box.append(row);
  });
  const total = el(
    "p",
    `Total due before repayments: ${money(p.totalDue)}`,
    "hint",
  );
  box.append(total);
}

/* Timeline: disbursement -> tenure end (initial interest) -> monthly fees (<= calc date) -> other charges -> repayments.
   One extra grey "Upcoming" row previews the next scheduled fee without counting it. */
function renderTimeline() {
  const events = [];
  const P = LOAN_CONFIG.principal;
  events.push({
    date: START,
    rank: 0,
    badge: ["Loan Created", "b-created"],
    desc: "Loan disbursement",
    interest: 0,
    paid: 0,
  });
  const tenureDone = TENURE_END <= state.calcDate;
  events.push({
    date: TENURE_END,
    rank: 1,
    badge: tenureDone
      ? ["Initial Tenure", "b-tenure"]
      : ["Upcoming", "b-upcoming"],
    desc: `End of original ${LOAN_CONFIG.tenureDays}-day tenure; initial interest charged once`,
    interest: INITIAL_INTEREST,
    paid: 0,
    future: !tenureDone,
  });
  const charges = chargesUpTo(state.calcDate);
  charges.forEach((d, i) =>
    events.push({
      date: d,
      rank: 2,
      badge: ["Monthly Fee", "b-monthly"],
      desc: `Monthly post-tenure fee #${i + 1}`,
      interest: MONTHLY_INTEREST,
      paid: 0,
    }),
  );
  events.push({
    date: chargeDate(charges.length),
    rank: 2,
    badge: ["Upcoming", "b-upcoming"],
    desc: `Next monthly fee #${charges.length + 1} (not yet charged)`,
    interest: MONTHLY_INTEREST,
    paid: 0,
    future: true,
  });
  LOAN_CONFIG.otherCharges
    .filter((c) => parseISO(c.date) <= state.calcDate)
    .forEach((c) =>
      events.push({
        date: parseISO(c.date),
        rank: 2,
        badge: ["Other Charge", "b-tenure"],
        desc: c.label,
        interest: c.amount,
        paid: 0,
      }),
    );
  state.repayments
    .filter((r) => parseISO(r.date) <= state.calcDate)
    .forEach((r) =>
      events.push({
        date: parseISO(r.date),
        rank: 3,
        badge: ["Payment Recorded", "b-paid"],
        desc: `Repayment ${money(r.amount)}${r.desc ? " - " + r.desc : ""}`,
        interest: 0,
        paid: r.amount,
      }),
    );
  events.sort((a, b) => a.date - b.date || a.rank - b.rank);

  let cum = 0,
    paid = 0;
  const body = $("timelineBody");
  body.replaceChildren();
  events.forEach((ev) => {
    let cumShown, dueShown;
    if (ev.future) {
      cumShown = cum + ev.interest;
      dueShown = P + cumShown - paid;
    } // projection only
    else {
      cum += ev.interest;
      paid += ev.paid;
      cumShown = cum;
      dueShown = P + cum - paid;
    }
    const tr = el("tr");
    tr.append(
      el("td", fmtShort.format(ev.date)),
      el("td", ev.desc, "desc"),
      el("td", money(P)),
      el("td", ev.interest ? money(ev.interest) : "-"),
      el("td", money(cumShown)),
      el("td", money(Math.max(dueShown, 0))),
    );
    const st = el("td");
    st.append(el("span", ev.badge[0], `badge ${ev.badge[1]}`));
    tr.append(st);
    body.append(tr);
  });
  applyLabels("timelineBody");
}

function renderHistory() {
  const body = $("historyBody");
  body.replaceChildren();
  if (!state.repayments.length) {
    const tr = el("tr");
    const td = el("td", "No repayments recorded yet.", "empty");
    td.colSpan = 5;
    tr.append(td);
    body.append(tr);
    return;
  }
  [...state.repayments]
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((r) => {
      const tr = el("tr");
      const btn = el("button", "Remove", "btn small");
      btn.type = "button";
      btn.addEventListener("click", () => {
        state.repayments = state.repayments.filter((x) => x.id !== r.id);
        saveRepayments();
        renderAll();
      });
      const act = el("td");
      act.append(btn);
      tr.append(
        el("td", fmtShort.format(parseISO(r.date))),
        el("td", money(r.amount)),
        el("td", r.desc || "-", "desc"),
        el("td", "Recorded on this device"),
        act,
      );
      body.append(tr);
    });
  applyLabels("historyBody");
}

/* ---------- Events ---------- */
function validCalcDate() {
  const d = parseISO($("calcDate").value);
  if (!d) return { error: "Enter a valid calculation date." };
  if (d < START)
    return {
      error: `Calculation date cannot be before the loan start date (${fmtShort.format(START)}).`,
    };
  return { date: d };
}

$("calcForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = $("calcError");
  const v = validCalcDate();
  const amt =
    $("calcRepaid").value.trim() === "" ? 0 : Number($("calcRepaid").value);
  if (v.error) {
    err.textContent = v.error;
    return;
  }
  if (!Number.isFinite(amt) || amt < 0) {
    err.textContent =
      "Amount repaid must be zero or more. Negative amounts are not allowed.";
    return;
  }
  err.textContent = "";
  state.calcDate = v.date;
  state.extraRepaid = round2(amt);
  renderAll();
});

$("calcDate").addEventListener("change", () => {
  const v = validCalcDate();
  $("calcError").textContent = v.error || "";
  if (v.date) {
    state.calcDate = v.date;
    renderAll();
  }
});

$("repayForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = $("repayError");
  const date = parseISO($("rDate").value);
  const amount = Number($("rAmount").value);
  if (!date) {
    err.textContent = "Enter a valid repayment date.";
    return;
  }
  if (date < START) {
    err.textContent = "Repayment date cannot be before the loan start date.";
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    err.textContent = "Repayment amount must be greater than zero.";
    return;
  }
  err.textContent = "";
  state.repayments.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    date: toISO(date),
    amount: round2(amount),
    desc: $("rDesc").value.trim().slice(0, 60),
  });
  saveRepayments();
  $("repayForm").reset();
  renderAll();
});

$("menuToggle").addEventListener("click", () => {
  const open = $("nav").classList.toggle("open");
  $("menuToggle").setAttribute("aria-expanded", String(open));
});
$("nav").addEventListener("click", (e) => {
  if (e.target.tagName === "A") {
    $("nav").classList.remove("open");
    $("menuToggle").setAttribute("aria-expanded", "false");
  }
});

/* ---------- Init: calculation date defaults to today ---------- */
renderStatic();
$("calcDate").value = toISO(state.calcDate);
$("calcDate").min = toISO(START);
$("rDate").value = toISO(state.calcDate);
renderAll();
