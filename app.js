// PrepBank -- client app. Talks directly to Supabase (auth + database) using
// the public anon key, and to our own /api/ai serverless function for
// anything that needs the (secret) Anthropic API key.
//
// This file intentionally avoids a build step / framework so it can be
// deployed as a plain static site. Everything is one state object + one
// render() function that rebuilds #app's HTML, plus a couple of delegated
// event listeners.

(function () {
  "use strict";

  const cfg = window.PREPBANK_CONFIG || {};
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
    document.getElementById("app").innerHTML =
      '<main><div class="card"><h2>Almost there</h2><p>Open <code>config.js</code> and paste in your Supabase project URL and anon key (Supabase dashboard &rarr; Project Settings &rarr; API). See README.md for the full setup steps.</p></div></main>';
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  const state = {
    session: null,
    profile: null,
    subscription: null,
    booted: false,
    view: "loading", // loading | auth | browse | class | build | test | quiz | flashcards | review
    authMode: "signin",
    authError: null,
    authBusy: false,
    classes: [],
    classesLoaded: false,
    classCounts: {},
    classQuery: "",
    classDept: "All",
    currentClass: null,
    tests: [],
    testsLoaded: false,
    currentTest: null,
    builder: {
      material: "",
      sourceNote: "",
      counts: { mc: 6, short: 4, flashcards: 8 },
      generated: null,
      busy: false,
      error: null,
      saving: false,
      official: true,
      access: "plus",
    },
    quiz: null,
    checkoutBusy: false,
    flash: null,
    subscribeOpen: false,
    subscribeBusy: false,
    toast: null,
    admin: {
      tests: [],
      classes: [],
      loaded: false,
      importText: "",
      importError: null,
      importBusy: false,
      classQuery: "",
    },
  };

  const DEPARTMENTS = ["All", "English", "Math", "Science", "Social Studies", "Languages", "CS & Business", "Health"];

  function isAdmin() {
    return !!(state.profile && state.profile.is_admin);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function setToast(msg) {
    state.toast = msg;
    render();
    if (msg) setTimeout(() => { if (state.toast === msg) { state.toast = null; render(); } }, 3500);
  }

  // ---------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------

  async function loadAfterAuth() {
    const uid = state.session.user.id;
    const [{ data: profile }, { data: sub }] = await Promise.all([
      sb.from("profiles").select("*").eq("id", uid).maybeSingle(),
      sb.from("subscriptions").select("*").eq("user_id", uid).maybeSingle(),
    ]);
    state.profile = profile || { id: uid, display_name: state.session.user.email };
    state.subscription = sub || { user_id: uid, status: "free" };
    state.view = "browse";
    render();
    loadClasses();
    handleCheckoutReturn();
  }

  async function refreshSubscription() {
    const { data } = await sb.from("subscriptions").select("*").eq("user_id", state.profile.id).maybeSingle();
    if (data) state.subscription = data;
    return data;
  }

  // Back from Stripe Checkout: the webhook may take a few seconds to land.
  async function handleCheckoutReturn() {
    const params = new URLSearchParams(location.search);
    const result = params.get("checkout");
    if (!result) return;
    history.replaceState(null, "", location.pathname);
    if (result === "cancel") { setToast("Checkout canceled -- you weren't charged."); return; }
    setToast("Payment received! Turning on PrepBank+...");
    for (let i = 0; i < 10; i++) {
      const sub = await refreshSubscription();
      if (sub && sub.status === "active") { render(); setToast("Welcome to PrepBank+! Every test is unlocked."); return; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    setToast("Payment went through, but PrepBank+ is still activating. Refresh in a minute.");
  }

  async function loadClasses() {
    const [{ data, error }, { data: counts }] = await Promise.all([
      sb.from("classes").select("*").order("sort_order", { ascending: true }).order("name", { ascending: true }),
      sb.from("class_test_counts").select("*"),
    ]);
    if (!error) {
      state.classes = data || [];
      state.classCounts = Object.fromEntries((counts || []).map((c) => [c.class_id, c]));
      state.classesLoaded = true;
      render();
    }
  }

  async function openClass(cls) {
    state.currentClass = cls;
    state.tests = [];
    state.testsLoaded = false;
    state.view = "class";
    render();
    const { data, error } = await sb
      .from("tests")
      .select("*, profiles(display_name)")
      .eq("class_id", cls.id)
      .order("created_at", { ascending: false });
    // Official tests first, then newest student tests
    if (!error) { state.tests = (data || []).sort((a, b) => (b.is_official ? 1 : 0) - (a.is_official ? 1 : 0)); }
    state.testsLoaded = true;
    render();
  }

  async function loadAdminData() {
    const [{ data: tests }, { data: classes }] = await Promise.all([
      sb.from("tests").select("*, classes(name)").order("created_at", { ascending: false }),
      sb.from("classes").select("*").order("sort_order", { ascending: true }).order("name", { ascending: true }),
    ]);
    state.admin.tests = tests || [];
    state.admin.classes = classes || [];
    state.admin.loaded = true;
    render();
  }

  async function handleAdminImport() {
    const a = state.admin;
    a.importError = null;
    let parsed;
    try {
      parsed = JSON.parse(a.importText);
    } catch (e) {
      a.importError = "That doesn't look like valid JSON -- paste exactly what Claude gave you, including the { and } at the ends.";
      render();
      return;
    }
    if (!parsed.className || !parsed.subject) {
      a.importError = "The import is missing a className or subject.";
      render();
      return;
    }
    const mc = Array.isArray(parsed.mc) ? parsed.mc : [];
    const short = Array.isArray(parsed.short) ? parsed.short : [];
    const flashcards = Array.isArray(parsed.flashcards) ? parsed.flashcards : [];
    if (mc.length + short.length + flashcards.length === 0) {
      a.importError = "That import has no questions or flashcards in it.";
      render();
      return;
    }
    a.importBusy = true;
    render();
    try {
      let cls = a.classes.find((c) => c.name.toLowerCase() === String(parsed.className).toLowerCase());
      if (!cls) {
        const { data, error } = await sb.from("classes").insert({
          name: parsed.className, subject: parsed.subject, teacher: parsed.teacher || null, created_by: state.profile.id,
        }).select().single();
        if (error) throw error;
        cls = data;
        a.classes.unshift(cls);
      }
      const mcAndShort = [
        ...mc.map((q) => ({ ...q, type: "mc" })),
        ...short.map((q) => ({ ...q, type: "short" })),
      ];
      const { data: test, error: testError } = await sb.from("tests").insert({
        class_id: cls.id,
        title: parsed.title || parsed.className + " Practice Test",
        created_by: state.profile.id,
        is_free: !!parsed.isFree,
        is_official: parsed.isOfficial !== false,
        question_count: mcAndShort.length,
        questions: mcAndShort,
        flashcards,
        source_note: parsed.sourceNote || "Imported via Claude",
      }).select("*, classes(name)").single();
      if (testError) throw testError;
      a.tests.unshift(test);
      a.importText = "";
      setToast('Imported "' + test.title + '" to PrepBank.');
    } catch (e) {
      a.importError = e.message || "Import failed.";
    }
    a.importBusy = false;
    render();
  }

  function isSubscribed() {
    return !!(state.subscription && state.subscription.status === "active");
  }

  function hasPlus() {
    return isSubscribed() || isAdmin() || !!(state.profile && state.profile.is_premium);
  }

  function testIsLocked(test) {
    if (test.is_free || hasPlus()) return false;
    if (state.profile && test.created_by === state.profile.id) return false;
    return !isSubscribed();
  }

  // ---------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------

  async function handleAuthSubmit(form) {
    state.authError = null;
    const email = form.email.value.trim();
    const password = form.password.value;
    const displayName = form.display_name ? form.display_name.value.trim() : "";
    state.authBusy = true;
    render();
    try {
      if (state.authMode === "signup") {
        if (!displayName) throw new Error("Enter a name so classmates know who added a test.");
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: { data: { display_name: displayName } },
        });
        if (error) throw error;
        if (!data.session) {
          state.authError = null;
          state.authBusy = false;
          setToast("Check your email to confirm your account, then sign in.");
          state.authMode = "signin";
          render();
          return;
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e) {
      state.authError = e.message || "Something went wrong.";
    }
    state.authBusy = false;
    render();
  }

  async function handleSignOut() {
    await sb.auth.signOut();
  }

  // ---------------------------------------------------------------------
  // Test builder (paste/upload material -> generate -> save)
  // ---------------------------------------------------------------------

  function resetBuilder() {
    const admin = isAdmin();
    state.builder = {
      material: "", sourceNote: "",
      counts: admin ? { mc: 15, short: 5, flashcards: 20 } : { mc: 6, short: 4, flashcards: 8 },
      generated: null, busy: false, error: null, saving: false,
      official: admin, access: "plus",
    };
  }

  async function extractFileText(file) {
    if (/\.txt$/i.test(file.name) || file.type === "text/plain") {
      return await file.text();
    }
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      if (!window.pdfjsLib) throw new Error("PDF reader did not load. Try pasting the text instead.");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
      const buf = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      let text = "";
      for (let i = 1; i <= pdf.numPages && text.length < 20000; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((it) => it.str).join(" ") + "\n\n";
      }
      if (!text.trim()) throw new Error("Couldn't find selectable text in that PDF (it may be a scanned image). Try pasting the text instead.");
      return text;
    }
    throw new Error("Upload a .txt or .pdf file, or paste the text below.");
  }

  async function handleFileUpload(file) {
    state.builder.error = null;
    render();
    try {
      const text = await extractFileText(file);
      state.builder.material = (state.builder.material ? state.builder.material + "\n\n" : "") + text.trim();
      state.builder.sourceNote = state.builder.sourceNote || file.name;
    } catch (e) {
      state.builder.error = e.message;
    }
    render();
  }

  async function handleGenerate() {
    const b = state.builder;
    b.error = null;
    if (!b.material.trim()) { b.error = "Paste or upload some study material first."; render(); return; }
    const total = b.counts.mc + b.counts.short + b.counts.flashcards;
    if (total <= 0) { b.error = "Ask for at least one question or flashcard."; render(); return; }
    b.busy = true;
    render();
    try {
      const resp = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          subject: state.currentClass.subject,
          className: state.currentClass.name,
          material: b.material,
          counts: b.counts,
        }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "Generation failed.");
      if ((json.mc || []).length + (json.short || []).length + (json.flashcards || []).length === 0) {
        throw new Error("The AI didn't return any questions -- try with more material.");
      }
      b.generated = json;
    } catch (e) {
      b.error = e.message || "Generation failed.";
    }
    b.busy = false;
    render();
  }

  function removeGenerated(kind, idx) {
    if (!state.builder.generated) return;
    state.builder.generated[kind].splice(idx, 1);
    render();
  }

  async function saveGeneratedTest(title) {
    const b = state.builder;
    if (!b.generated) return;
    b.saving = true;
    render();
    try {
      const mcAndShort = [
        ...b.generated.mc.map((q) => ({ ...q, type: "mc" })),
        ...b.generated.short.map((q) => ({ ...q, type: "short" })),
      ];
      const admin = isAdmin();
      const row = {
        class_id: state.currentClass.id,
        title: title || "Practice test",
        created_by: state.profile.id,
        // Admins choose free vs PrepBank+. For students, the first test in a class is free to try.
        is_free: admin ? b.access === "free" : state.tests.length === 0,
        is_official: admin && !!b.official,
        question_count: mcAndShort.length,
        questions: mcAndShort,
        flashcards: b.generated.flashcards,
        source_note: b.sourceNote || null,
      };
      const { data, error } = await sb.from("tests").insert(row).select("*, profiles(display_name)").single();
      if (error) throw error;
      state.tests.unshift(data);
      state.tests.sort((a, c) => (c.is_official ? 1 : 0) - (a.is_official ? 1 : 0));
      resetBuilder();
      state.view = "class";
      setToast("Practice test saved.");
    } catch (e) {
      b.error = e.message || "Couldn't save the test.";
      b.saving = false;
      render();
    }
  }

  // ---------------------------------------------------------------------
  // Quiz (study or timed test mode)
  // ---------------------------------------------------------------------

  function startQuiz(test, mode) {
    const questions = (test.questions || []).map((q, i) => ({ ...q, _id: "q" + i }));
    if (questions.length === 0) { setToast("This test has no multiple-choice or short-answer questions yet."); return; }
    const mcCount = questions.filter((q) => q.type === "mc").length;
    const shortCount = questions.filter((q) => q.type === "short").length;
    const timeLimitSec = Math.max(120, mcCount * 40 + shortCount * 70);
    state.quiz = {
      test, mode, questions, index: 0,
      answers: {}, revealed: {},
      timeLimitSec, remainingSec: timeLimitSec, timerHandle: null,
      submitting: false, result: null,
    };
    state.view = "quiz";
    render();
    if (mode === "test") startTimer();
  }

  function startTimer() {
    const q = state.quiz;
    if (!q) return;
    q.timerHandle = setInterval(() => {
      q.remainingSec -= 1;
      const el = document.getElementById("quiz-timer");
      if (el) {
        el.textContent = formatTime(q.remainingSec);
        el.classList.toggle("low", q.remainingSec <= 30);
      }
      if (q.remainingSec <= 0) {
        clearInterval(q.timerHandle);
        submitQuiz();
      }
    }, 1000);
  }

  function stopTimer() {
    if (state.quiz && state.quiz.timerHandle) { clearInterval(state.quiz.timerHandle); state.quiz.timerHandle = null; }
  }

  function formatTime(totalSec) {
    const s = Math.max(0, totalSec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ":" + String(r).padStart(2, "0");
  }

  async function submitQuiz() {
    const q = state.quiz;
    if (!q || q.submitting) return;
    stopTimer();
    q.submitting = true;
    render();

    const perQuestion = [];
    const shortToGrade = [];
    q.questions.forEach((question) => {
      const given = q.answers[question._id];
      if (question.type === "mc") {
        const correct = Number(given) === Number(question.correctIndex);
        perQuestion.push({ id: question._id, type: "mc", given, correct });
      } else {
        perQuestion.push({ id: question._id, type: "short", given: given || "" });
        shortToGrade.push({
          id: question._id,
          prompt: question.prompt,
          expectedAnswer: question.answer,
          studentAnswer: given || "",
        });
      }
    });

    if (shortToGrade.length > 0) {
      try {
        const resp = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "grade",
            pairs: shortToGrade.map(({ prompt, expectedAnswer, studentAnswer }) => ({ prompt, expectedAnswer, studentAnswer })),
          }),
        });
        const json = await resp.json();
        if (resp.ok && Array.isArray(json.results)) {
          shortToGrade.forEach((item, i) => {
            const r = json.results[i] || {};
            const target = perQuestion.find((p) => p.id === item.id);
            target.correct = !!r.isCorrect;
            target.feedback = r.feedback || "";
          });
        } else {
          shortToGrade.forEach((item) => {
            const target = perQuestion.find((p) => p.id === item.id);
            const norm = (s) => String(s || "").toLowerCase().trim();
            target.correct = norm(item.studentAnswer).length > 0 && norm(item.studentAnswer) === norm(item.expectedAnswer);
            target.feedback = "Auto-grading was unavailable, so this was matched by exact text.";
          });
        }
      } catch (e) {
        shortToGrade.forEach((item) => {
          const target = perQuestion.find((p) => p.id === item.id);
          target.correct = false;
          target.feedback = "Couldn't reach the grader.";
        });
      }
    }

    const correctCount = perQuestion.filter((p) => p.correct).length;
    q.result = { perQuestion, correctCount, total: perQuestion.length };

    if (state.profile) {
      sb.from("attempts").insert({
        user_id: state.profile.id,
        test_id: q.test.id,
        mode: q.mode,
        score: correctCount,
        total: perQuestion.length,
        answers: perQuestion,
      }).then(() => {});
    }

    q.submitting = false;
    state.view = "review";
    render();
  }

  // ---------------------------------------------------------------------
  // Flashcards
  // ---------------------------------------------------------------------

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startFlashcards(test) {
    const cards = test.flashcards || [];
    if (cards.length === 0) { setToast("This test has no flashcards."); return; }
    state.flash = { test, cards, order: cards.map((_, i) => i), index: 0, flipped: false, know: 0, learning: 0, done: {} };
    state.view = "flashcards";
    render();
  }

  // ---------------------------------------------------------------------
  // Subscription (placeholder -- swap for real Stripe later, see README)
  // ---------------------------------------------------------------------

  // Calls one of our /api billing endpoints and sends the browser to the Stripe page it returns.
  async function goToStripe(endpoint) {
    state.subscribeBusy = true;
    render();
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + state.session.access_token },
        body: "{}",
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json.url) throw new Error(json.error || "Couldn't reach Stripe.");
      window.location.href = json.url;
    } catch (e) {
      state.subscribeBusy = false;
      setToast(e.message);
    }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function render() {
    const app = document.getElementById("app");
    app.innerHTML = shell();
    attachDynamicListeners();
  }

  function shell() {
    if (!state.session) return authScreen();
    const nav = `
      <div class="topbar">
        <a href="#" class="brand" data-action="nav-browse">PrepBank</a>
        <nav>
          <button data-action="nav-browse" class="${state.view === "browse" ? "active" : ""}">Browse classes</button>
          ${state.profile && state.profile.is_admin ? `<button data-action="nav-admin" class="${state.view === "admin" ? "active" : ""}">Admin</button>` : ""}
        </nav>
        <span class="pill ${hasPlus() ? "gold" : ""}" data-action="open-subscribe" style="cursor:pointer">
          ${isAdmin() ? "Admin &middot; PrepBank+" : hasPlus() ? "PrepBank+" : "Free plan &middot; Upgrade"}
        </span>
        <span class="pill">${esc(state.profile ? state.profile.display_name : "")}</span>
        <button class="btn ghost small" data-action="signout">Sign out</button>
      </div>`;
    let body = "";
    switch (state.view) {
      case "browse": body = browseView(); break;
      case "class": body = classView(); break;
      case "build": body = buildView(); break;
      case "test": body = testView(); break;
      case "quiz": body = quizView(); break;
      case "review": body = reviewView(); break;
      case "flashcards": body = flashcardsView(); break;
      case "admin": body = adminView(); break;
      default: body = '<main><p>Loading&hellip;</p></main>';
    }
    return `<div class="shell">${nav}<main>${body}</main>${footer()}</div>
      ${state.toast ? `<div class="modal-backdrop" style="background:transparent;align-items:flex-end;justify-content:center;pointer-events:none">
        <div class="card" style="pointer-events:auto;max-width:420px">${esc(state.toast)}</div></div>` : ""}
      ${state.subscribeOpen ? subscribeModal() : ""}`;
  }

  function footer() {
    return `<footer class="small-print">PrepBank &middot; made by students, for students. Practice tests are AI-generated from material your classmates provide -- always double check against your actual class before an exam.</footer>`;
  }

  function authScreen() {
    const signup = state.authMode === "signup";
    return `<div class="shell">
      <div class="topbar"><span class="brand">PrepBank</span></div>
      <main>
        <div class="hero">
          <h1>Turn your study guide into a practice test.</h1>
          <p class="lede">Paste or upload your class materials, PrepBank generates multiple-choice, short-answer, and flashcards -- shared with everyone else in your school taking the same class.</p>
        </div>
        <div class="card" style="max-width:420px">
          <div class="tabs">
            <button class="btn ${!signup ? "primary" : "ghost"}" data-action="auth-tab-signin">Sign in</button>
            <button class="btn ${signup ? "primary" : "ghost"}" data-action="auth-tab-signup">Create account</button>
          </div>
          ${state.authError ? `<div class="error-box">${esc(state.authError)}</div>` : ""}
          <form id="auth-form">
            ${signup ? `<div class="field"><label for="display_name">Your name</label><input type="text" id="display_name" name="display_name" placeholder="How classmates will see you" required /></div>` : ""}
            <div class="field"><label for="email">School email</label><input type="email" id="email" name="email" required /></div>
            <div class="field"><label for="password">Password</label><input type="password" id="password" name="password" minlength="6" required /></div>
            <button class="btn primary block" type="submit" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "Please wait&hellip;" : signup ? "Create account" : "Sign in"}</button>
          </form>
        </div>
      </main>
      ${footer()}
    </div>`;
  }

  function levelTag(level) {
    if (!level || level === "On-Level") return "";
    const cls = level === "AP" || level === "Dual Credit" ? "level-ap" : level === "Honors" ? "level-honors" : "level-elective";
    return `<span class="level ${cls}">${esc(level)}</span>`;
  }

  function filteredClasses() {
    const q = state.classQuery.trim().toLowerCase();
    // Let "apush", "calc bc", "apwh" style searches still match
    const aliases = { apush: "united states history", apwh: "ap world history", apgov: "united states government", apes: "environmental science", aphug: "human geography", calc: "calcul", precalc: "pre-calculus", chem: "chem", bio: "biolog", gov: "government", us: "united states", csa: "computer science a", apcsp: "ap computer science principles", psych: "psycholog", econ: "econom", lang: "language", lit: "literature" };
    const terms = q.split(/\s+/).filter(Boolean).map((t) => aliases[t] || t);
    return state.classes.filter((c) => {
      if (state.classDept !== "All" && c.subject !== state.classDept) return false;
      const hay = `${c.name} ${c.subject} ${c.level || ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  function classResults() {
    const list = filteredClasses();
    if (list.length === 0) {
      return `<div class="card"><p>No classes match "${esc(state.classQuery)}". Every HPHS course is already listed -- try a shorter search like "chem" or "AP".</p></div>`;
    }
    const groups = {};
    list.forEach((c) => { (groups[c.subject] = groups[c.subject] || []).push(c); });
    return Object.entries(groups).map(([dept, classes]) => `
      <h3 class="dept-heading">${esc(dept)} <span class="meta">${classes.length}</span></h3>
      <div class="grid cols-3">
        ${classes.map((c) => {
          const n = state.classCounts[c.id] || { test_count: 0, official_count: 0 };
          return `<div class="card class-card" data-action="open-class" data-id="${c.id}">
            <div class="class-card-top">${levelTag(c.level)}${n.official_count ? '<span class="badge-official small">&#10003; Official</span>' : ""}</div>
            <h3>${esc(c.name)}</h3>
            <div class="meta">${n.test_count ? `${n.test_count} practice test${n.test_count === 1 ? "" : "s"}` : "No tests yet &middot; be the first"}</div>
          </div>`;
        }).join("")}
      </div>`).join("");
  }

  function browseView() {
    if (!state.classesLoaded) return "<p>Loading classes&hellip;</p>";
    return `
      <div class="browse-head">
        <h2 style="margin:0">Find your class</h2>
        <p class="help" style="margin:.2rem 0 0">Every Highland Park High School course that needs studying. Pick yours to practice -- or add your study guide so everyone in the class can use it.</p>
      </div>
      <input type="text" id="class-search" class="search" placeholder="Search classes -- try &quot;AP Bio&quot;, &quot;Chemistry Honors&quot;, &quot;Spanish III&quot;" value="${esc(state.classQuery)}" autocomplete="off" />
      <div class="chips">
        ${DEPARTMENTS.map((d) => `<button class="chip ${state.classDept === d ? "on" : ""}" data-action="filter-dept" data-dept="${esc(d)}">${esc(d)}</button>`).join("")}
      </div>
      <div id="class-results">${classResults()}</div>
    `;
  }

  function classView() {
    const c = state.currentClass;
    if (!c) return "";
    const row = (t) => {
      const locked = testIsLocked(t);
      const author = t.profiles && t.profiles.display_name;
      return `<div class="card test-row ${t.is_official ? "official" : "student"}" data-action="open-test" data-id="${t.id}">
        <div>
          <div class="test-badges">
            ${t.is_official ? '<span class="badge-official">&#10003; Official PrepBank</span>' : '<span class="badge-student">Student-made</span>'}
            ${t.is_free ? '<span class="tag">Free</span>' : ""}
          </div>
          <strong>${esc(t.title)}</strong>
          <div class="meta">${t.question_count} question${t.question_count === 1 ? "" : "s"}${(t.flashcards || []).length ? ` &middot; ${t.flashcards.length} flashcards` : ""}${!t.is_official && author ? ` &middot; shared by ${esc(author)}` : ""}</div>
        </div>
        ${locked ? `<span class="lock">&#128274; PrepBank+</span>` : `<span class="btn small">Open &rarr;</span>`}
      </div>`;
    };
    const official = state.tests.filter((t) => t.is_official);
    const student = state.tests.filter((t) => !t.is_official);
    const addLabel = isAdmin() ? "+ Publish an official test" : "+ Add your study guide";
    return `
      <button class="btn ghost small" data-action="nav-browse">&larr; All classes</button>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:0.5rem 0 1rem">
        <div>
          <span class="tag">${esc(c.subject)}</span> ${levelTag(c.level)}
          <h2 style="margin:.3rem 0 0">${esc(c.name)}</h2>
        </div>
        <button class="btn ${isAdmin() ? "primary" : "gold"}" data-action="start-build-test">${addLabel}</button>
      </div>
      ${!state.testsLoaded ? "<p>Loading tests&hellip;</p>" : state.tests.length === 0 ? `<div class="card"><p>No practice tests for this class yet. Add your study guide, notes or review sheet and PrepBank will turn it into the first practice test -- free for everyone in ${esc(c.name)}.</p></div>` : `
        ${official.length ? `<h3 class="section-label">Official tests</h3>${official.map(row).join("")}` : ""}
        ${student.length ? `<h3 class="section-label">From your classmates</h3>${student.map(row).join("")}` : ""}`}
    `;
  }

  function buildView() {
    const b = state.builder;
    if (b.generated) return buildPreview();
    const admin = isAdmin();
    const header = admin ? `
      <div class="admin-banner">
        <div><span class="badge-official">&#10003; Official PrepBank</span> <strong>Publishing as admin</strong></div>
        <div class="help" style="margin:0">Official tests are pinned to the top of ${esc(state.currentClass.name)} with a checkmark, and you decide whether they're free or PrepBank+.</div>
      </div>
      <h2>Publish an official test</h2>
      <div class="card admin-options">
        <label class="check-row"><input type="checkbox" id="opt-official" ${b.official ? "checked" : ""} /> Mark as <strong>Official PrepBank</strong> test</label>
        <div class="field" style="margin:.8rem 0 0">
          <label>Who can take it?</label>
          <div class="seg">
            <button class="${b.access === "free" ? "on" : ""}" data-action="set-access" data-access="free">Free for everyone</button>
            <button class="${b.access === "plus" ? "on" : ""}" data-action="set-access" data-access="plus">&#128274; PrepBank+ only</button>
          </div>
        </div>
      </div>` : `
      <h2>Add your study guide</h2>
      <p class="help">Share what your teacher gave you -- a review sheet, notes, or a study guide -- and PrepBank turns it into practice questions and flashcards for everyone in ${esc(state.currentClass.name)}.</p>
      <div class="note-box student-note">
        <strong>Your test will show as "Student-made" and credit you by name.</strong>
        Only share material from this class. No actual tests, quizzes or answer keys -- that's cheating and admins will remove it.
        ${state.tests.length === 0 ? "<br />Since this is the first test in this class, it'll be free for everyone." : ""}
      </div>`;
    return `
      <button class="btn ghost small" data-action="back-to-class">&larr; ${esc(state.currentClass.name)}</button>
      ${header}
      ${b.error ? `<div class="error-box">${esc(b.error)}</div>` : ""}
      <div class="card ${admin ? "admin-card" : ""}">
        <div class="field">
          <label for="material">Study material</label>
          <textarea id="material" placeholder="Paste your study guide, notes, or teacher's review sheet here...">${esc(b.material)}</textarea>
          <div class="help">${b.material.length.toLocaleString()} characters</div>
        </div>
        <div class="field">
          <label for="file-upload">Or upload a file</label>
          <input type="file" id="file-upload" accept=".txt,.pdf,text/plain,application/pdf" />
          <div class="help">.txt or .pdf (PDF must have selectable text, not a scanned photo).</div>
        </div>
        <div class="count-inputs">
          <div class="field"><label for="count-mc">Multiple choice</label><input type="number" id="count-mc" min="0" max="25" value="${b.counts.mc}" /></div>
          <div class="field"><label for="count-short">Short answer</label><input type="number" id="count-short" min="0" max="25" value="${b.counts.short}" /></div>
          <div class="field"><label for="count-flash">Flashcards</label><input type="number" id="count-flash" min="0" max="40" value="${b.counts.flashcards}" /></div>
        </div>
        <button class="btn ${admin ? "primary" : "gold"}" data-action="generate-test" ${b.busy ? "disabled" : ""}>${b.busy ? "Generating&hellip; (this can take up to a minute)" : admin ? "Generate official test" : "Generate practice test"}</button>
      </div>
      ${admin ? `<p class="help">Tip: you can also send your study material to Claude in chat and paste the result into Admin &rarr; Import.</p>` : ""}
    `;
  }

  function buildPreview() {
    const b = state.builder;
    const g = b.generated;
    const mcHtml = g.mc.map((q, i) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;gap:1rem">
          <strong>MC ${i + 1}. ${esc(q.prompt)}</strong>
          <button class="btn ghost small" data-action="remove-generated" data-kind="mc" data-idx="${i}">Remove</button>
        </div>
        <ol type="A" style="margin:.6rem 0 0;padding-left:1.4rem">
          ${(q.choices || []).map((c, ci) => `<li style="${ci === q.correctIndex ? "color:var(--good);font-weight:600" : ""}">${esc(c)}</li>`).join("")}
        </ol>
      </div>`).join("");
    const shortHtml = g.short.map((q, i) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;gap:1rem">
          <strong>Short answer ${i + 1}. ${esc(q.prompt)}</strong>
          <button class="btn ghost small" data-action="remove-generated" data-kind="short" data-idx="${i}">Remove</button>
        </div>
        <div class="help">Expected: ${esc(q.answer)}</div>
      </div>`).join("");
    const flashHtml = g.flashcards.map((f, i) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;gap:1rem">
          <strong>${esc(f.term)}</strong>
          <button class="btn ghost small" data-action="remove-generated" data-kind="flashcards" data-idx="${i}">Remove</button>
        </div>
        <div class="help">${esc(f.definition)}</div>
      </div>`).join("");
    return `
      <button class="btn ghost small" data-action="discard-generated">&larr; Start over</button>
      <h2>Review before saving</h2>
      <p class="help">Skim these for anything off before your classmates see them -- remove any question that doesn't look right.</p>
      ${b.error ? `<div class="error-box">${esc(b.error)}</div>` : ""}
      <div class="card">
        <div class="field"><label for="test-title">Test title</label><input type="text" id="test-title" placeholder="e.g. Unit 3 -- Cell Energy" value="${esc(state.currentClass.name + " Practice Test")}" /></div>
        ${isAdmin() ? `<p class="help" style="margin-top:0">Publishing as ${b.official ? "<strong>&#10003; Official</strong>" : "a regular test"} &middot; ${b.access === "free" ? "Free for everyone" : "PrepBank+ only"}</p>` : ""}
        <button class="btn primary" data-action="save-test" ${b.saving ? "disabled" : ""}>${b.saving ? "Saving&hellip;" : isAdmin() ? "Publish to class" : "Share with my class"}</button>
      </div>
      ${g.mc.length ? `<h3 style="margin-top:1.5rem">Multiple choice (${g.mc.length})</h3>${mcHtml}` : ""}
      ${g.short.length ? `<h3 style="margin-top:1.5rem">Short answer (${g.short.length})</h3>${shortHtml}` : ""}
      ${g.flashcards.length ? `<h3 style="margin-top:1.5rem">Flashcards (${g.flashcards.length})</h3>${flashHtml}` : ""}
    `;
  }

  function testView() {
    const t = state.currentTest;
    if (!t) return "";
    const locked = testIsLocked(t);
    const mc = (t.questions || []).filter((q) => q.type === "mc").length;
    const short = (t.questions || []).filter((q) => q.type === "short").length;
    return `
      <button class="btn ghost small" data-action="back-to-class">&larr; ${esc(state.currentClass.name)}</button>
      <div class="test-badges" style="margin-top:.6rem">${t.is_official ? '<span class="badge-official">&#10003; Official PrepBank</span>' : `<span class="badge-student">Student-made${t.profiles && t.profiles.display_name ? " &middot; shared by " + esc(t.profiles.display_name) : ""}</span>`}</div>
      <h2>${esc(t.title)}</h2>
      <p class="meta">${mc} multiple choice &middot; ${short} short answer &middot; ${(t.flashcards || []).length} flashcards</p>
      ${!t.is_official ? `<p class="help">Made from a classmate's study material -- double-check anything that looks off against your notes.</p>` : ""}
      ${locked ? `
        <div class="card">
          <p><strong>This test is part of PrepBank+.</strong> Unlock it (and every other test your school has added) to practice here.</p>
          <button class="btn gold" data-action="open-subscribe">Unlock PrepBank+</button>
        </div>` : `
        <div class="grid cols-2">
          <div class="card">
            <h3>Study mode</h3>
            <p class="help">Go at your own pace. See the right answer and explanation right after each question -- no timer, no score pressure.</p>
            <button class="btn primary block" data-action="start-study">Practice (untimed)</button>
          </div>
          <div class="card">
            <h3>Test mode</h3>
            <p class="help">Timed, like the real thing. Answers are hidden until you finish, then you get a score and a full review.</p>
            <button class="btn primary block" data-action="start-test-mode">Take the test (timed)</button>
          </div>
          ${(t.flashcards || []).length ? `<div class="card">
            <h3>Flashcards</h3>
            <p class="help">${t.flashcards.length} term/definition cards to flip through and drill.</p>
            <button class="btn block" data-action="start-flashcards">Study flashcards</button>
          </div>` : ""}
        </div>`}
    `;
  }

  function quizView() {
    const q = state.quiz;
    const question = q.questions[q.index];
    const pct = Math.round(((q.index) / q.questions.length) * 100);
    const given = q.answers[question._id];
    const revealed = !!q.revealed[question._id];
    const isLast = q.index === q.questions.length - 1;

    let body = "";
    if (question.type === "mc") {
      body = (question.choices || []).map((c, i) => {
        let cls = "choice";
        if (String(given) === String(i)) cls += " selected";
        if (revealed) {
          if (i === question.correctIndex) cls += " correct";
          else if (String(given) === String(i)) cls += " incorrect";
        }
        return `<div class="${cls}" data-action="select-choice" data-idx="${i}">
          <input type="radio" ${String(given) === String(i) ? "checked" : ""} readonly />
          <span>${esc(c)}</span>
        </div>`;
      }).join("");
    } else {
      body = `<textarea id="short-answer-input" placeholder="Type your answer&hellip;" style="min-height:100px">${esc(given || "")}</textarea>`;
    }

    const showCheck = q.mode === "study" && !revealed;
    const feedback = q.mode === "study" && revealed ? `
      <div class="note-box" style="margin-top:1rem">
        ${question.type === "mc" ? (String(given) === String(question.correctIndex) ? '<strong style="color:var(--good)">Correct.</strong> ' : '<strong style="color:var(--bad)">Not quite.</strong> ') + esc(question.explanation || "") : `<strong>Expected answer:</strong> ${esc(question.answer)}`}
      </div>` : "";

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem">
        <span class="meta">Question ${q.index + 1} of ${q.questions.length} &middot; ${q.mode === "test" ? "Test mode" : "Study mode"}</span>
        ${q.mode === "test" ? `<span id="quiz-timer" class="timer ${q.remainingSec <= 30 ? "low" : ""}">${formatTime(q.remainingSec)}</span>` : ""}
      </div>
      <div class="progressbar"><div style="width:${pct}%"></div></div>
      <div class="card">
        <h3>${esc(question.prompt)}</h3>
        ${body}
        ${feedback}
      </div>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem">
        <button class="btn" data-action="quiz-prev" ${q.index === 0 ? "disabled" : ""}>&larr; Back</button>
        ${showCheck ? `<button class="btn primary" data-action="quiz-check">Check answer</button>` : ""}
        ${!showCheck && !isLast ? `<button class="btn primary" data-action="quiz-next">Next &rarr;</button>` : ""}
        ${!showCheck && isLast ? `<button class="btn gold" data-action="quiz-submit" ${q.submitting ? "disabled" : ""}>${q.submitting ? "Grading&hellip;" : q.mode === "test" ? "Submit test" : "Finish"}</button>` : ""}
      </div>
    `;
  }

  function reviewView() {
    const q = state.quiz;
    const r = q.result;
    const pct = r.total ? Math.round((r.correctCount / r.total) * 100) : 0;
    const items = q.questions.map((question) => {
      const p = r.perQuestion.find((x) => x.id === question._id);
      const correct = !!p.correct;
      return `<div class="review-item">
        <div class="verdict ${correct ? "correct" : "incorrect"}">${correct ? "CORRECT" : "INCORRECT"}</div>
        <strong>${esc(question.prompt)}</strong>
        ${question.type === "mc" ? `
          <div class="help">Your answer: ${p.given != null ? esc(question.choices[p.given]) : "(no answer)"}</div>
          <div class="help">Correct answer: ${esc(question.choices[question.correctIndex])}</div>
          ${question.explanation ? `<div class="help">${esc(question.explanation)}</div>` : ""}
        ` : `
          <div class="help">Your answer: ${esc(p.given || "(no answer)")}</div>
          <div class="help">Expected: ${esc(question.answer)}</div>
          ${p.feedback ? `<div class="help">${esc(p.feedback)}</div>` : ""}
        `}
      </div>`;
    }).join("");
    return `
      <div class="score-hero">
        <div class="score">${r.correctCount}/${r.total}</div>
        <p class="meta">${pct}% &middot; ${state.quiz.mode === "test" ? "Test mode" : "Study mode"}</p>
      </div>
      <div class="card">${items}</div>
      <div style="margin-top:1rem;display:flex;gap:.6rem;flex-wrap:wrap">
        <button class="btn primary" data-action="close-review">Back to test</button>
      </div>
    `;
  }

  function flashcardsView() {
    const f = state.flash;
    const card = f.cards[f.order[f.index]];
    return `
      <button class="btn ghost small" data-action="close-flashcards">&larr; ${esc(f.test.title)}</button>
      <p class="meta" style="text-align:center;margin-top:.5rem">Card ${f.index + 1} of ${f.cards.length} &middot; Know it: ${f.know} &middot; Still learning: ${f.learning}</p>
      <div class="flashcard-wrap">
        <div class="flashcard" data-action="flip-card">
          <div>
            <div class="side-label">${f.flipped ? "Definition" : "Term"}</div>
            <div>${esc(f.flipped ? card.definition : card.term)}</div>
          </div>
        </div>
      </div>
      <div class="flashcard-controls">
        <button class="btn" data-action="flash-prev">&larr; Prev</button>
        <button class="btn danger" data-action="flash-learning">Still learning</button>
        <button class="btn primary" data-action="flash-know">Know it</button>
        <button class="btn" data-action="flash-next">Next &rarr;</button>
        <button class="btn ghost" data-action="flash-shuffle">Shuffle</button>
      </div>
    `;
  }

  function subscribeModal() {
    return `<div class="modal-backdrop" data-action="close-subscribe-backdrop">
      <div class="modal">
        <h2>PrepBank+</h2>
        ${isAdmin() ? `<p>You're an admin, so every test is already unlocked for you.</p>` : isSubscribed() ? `
          <p>You have PrepBank+ -- every practice test in every class is unlocked.</p>
          ${state.subscription.current_period_end ? `<p class="help">Renews ${new Date(state.subscription.current_period_end).toLocaleDateString()}.</p>` : ""}
          <button class="btn block" data-action="manage-billing" ${state.subscribeBusy ? "disabled" : ""}>${state.subscribeBusy ? "Opening&hellip;" : "Manage or cancel subscription"}</button>` : `
          <div class="price-line"><span class="price">$3</span><span class="help">/ month &middot; cancel anytime</span></div>
          <ul class="perks">
            <li>Every official PrepBank test, for every HPHS class</li>
            <li>Every test your classmates have shared</li>
            <li>Timed test mode, AI-graded short answers, flashcards</li>
          </ul>
          <button class="btn gold block" data-action="start-checkout" ${state.subscribeBusy ? "disabled" : ""}>${state.subscribeBusy ? "Opening checkout&hellip;" : "Get PrepBank+"}</button>
          <p class="help" style="text-align:center">Secure checkout by Stripe. You'll come right back here after paying.</p>`}
        <button class="btn ghost block" data-action="close-subscribe" style="margin-top:.5rem">Close</button>
      </div>
    </div>`;
  }

  function adminView() {
    const a = state.admin;
    if (!a.loaded) return "<p>Loading admin tools&hellip;</p>";
    const testsRows = a.tests.map((t) => `
      <div class="card test-row ${t.is_official ? "official" : "student"}">
        <div>
          <div class="test-badges">${t.is_official ? '<span class="badge-official">&#10003; Official</span>' : '<span class="badge-student">Student-made</span>'} ${t.is_free ? '<span class="tag">Free</span>' : '<span class="tag">PrepBank+</span>'}</div>
          <strong>${esc(t.title)}</strong>
          <div class="meta">${esc(t.classes ? t.classes.name : "")} &middot; ${t.question_count} question${t.question_count === 1 ? "" : "s"} &middot; ${(t.flashcards || []).length} flashcards</div>
        </div>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap">
          <button class="btn small" data-action="admin-toggle-official" data-id="${t.id}" data-official="${t.is_official}">${t.is_official ? "Remove Official" : "Make Official"}</button>
          <button class="btn small" data-action="admin-toggle-free" data-id="${t.id}" data-free="${t.is_free}">${t.is_free ? "Make PrepBank+" : "Make free"}</button>
          <button class="btn small danger" data-action="admin-delete-test" data-id="${t.id}">Delete</button>
        </div>
      </div>`).join("");
    const cq = a.classQuery.trim().toLowerCase();
    const shownClasses = a.classes.filter((c) => !cq || `${c.name} ${c.subject}`.toLowerCase().includes(cq));
    const classRows = shownClasses.map((c) => `
      <div class="admin-class-row">
        <div><strong>${esc(c.name)}</strong> <span class="meta">${esc(c.subject)}${c.level ? " &middot; " + esc(c.level) : ""}</span></div>
        <button class="btn small danger" data-action="admin-delete-class" data-id="${c.id}">Delete</button>
      </div>`).join("");

    return `
      <h2>Admin</h2>
      <div class="card">
        <h3>Import a test from Claude</h3>
        <p class="help">In your chat with Claude, paste your notes and ask for a "PrepBank import" for a specific class. Copy the JSON block Claude replies with and paste it below -- this creates the class automatically if it doesn't exist yet, and skips the AI generation step on the site (it's already generated).</p>
        ${a.importError ? `<div class="error-box">${esc(a.importError)}</div>` : ""}
        <textarea id="admin-import-text" placeholder='{"className": "...", "subject": "...", "title": "...", "isFree": false, "isOfficial": true, "mc": [...], "short": [...], "flashcards": [...]}'>${esc(a.importText)}</textarea>
        <button class="btn primary" style="margin-top:.6rem" data-action="admin-import" ${a.importBusy ? "disabled" : ""}>${a.importBusy ? "Importing&hellip;" : "Import to PrepBank"}</button>
      </div>
      <h3 style="margin-top:1.5rem">All tests (${a.tests.length})</h3>
      ${a.tests.length === 0 ? '<p class="help">No tests yet.</p>' : testsRows}
      <h3 style="margin-top:1.5rem">Classes (${a.classes.length})</h3>
      <p class="help">Only admins can add classes. Students search this list and add study material to it.</p>
      <div class="card">
        <form id="admin-class-form" class="admin-class-form">
          <input type="text" name="name" placeholder="New class name, e.g. AP Art History" required />
          <select name="subject">${DEPARTMENTS.filter((d) => d !== "All").map((d) => `<option>${esc(d)}</option>`).join("")}</select>
          <select name="level"><option>On-Level</option><option>Honors</option><option>AP</option><option>Dual Credit</option><option>Elective</option></select>
          <button class="btn primary" type="submit">Add class</button>
        </form>
      </div>
      <input type="text" id="admin-class-search" class="search" style="margin-top:1rem" placeholder="Filter classes&hellip;" value="${esc(a.classQuery)}" />
      <div class="card admin-class-list">${classRows || '<p class="help">No classes match.</p>'}</div>
    `;
  }

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------

  function attachDynamicListeners() {
    const fileInput = document.getElementById("file-upload");
    if (fileInput) fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleFileUpload(file);
    });
    const materialEl = document.getElementById("material");
    if (materialEl) materialEl.addEventListener("input", (e) => { state.builder.material = e.target.value; });
    ["count-mc", "count-short", "count-flash"].forEach((id, i) => {
      const key = ["mc", "short", "flashcards"][i];
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", (e) => { state.builder.counts[key] = Number(e.target.value) || 0; });
    });
    const shortInput = document.getElementById("short-answer-input");
    if (shortInput) shortInput.addEventListener("input", (e) => {
      const q = state.quiz;
      q.answers[q.questions[q.index]._id] = e.target.value;
    });
    const importEl = document.getElementById("admin-import-text");
    if (importEl) importEl.addEventListener("input", (e) => { state.admin.importText = e.target.value; });
    // Class search re-renders only the results so the input keeps focus while typing
    const searchEl = document.getElementById("class-search");
    if (searchEl) searchEl.addEventListener("input", (e) => {
      state.classQuery = e.target.value;
      document.getElementById("class-results").innerHTML = classResults();
    });
    const adminSearch = document.getElementById("admin-class-search");
    if (adminSearch) adminSearch.addEventListener("input", (e) => {
      state.admin.classQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = document.getElementById("admin-class-search");
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    });
    const officialEl = document.getElementById("opt-official");
    if (officialEl) officialEl.addEventListener("change", (e) => { state.builder.official = e.target.checked; });
  }

  document.addEventListener("submit", (e) => {
    if (e.target.id === "auth-form") { e.preventDefault(); handleAuthSubmit(e.target); }
    if (e.target.id === "admin-class-form") {
      e.preventDefault();
      const f = e.target;
      sb.from("classes").insert({
        name: f.name.value.trim(), subject: f.subject.value, level: f.level.value,
        created_by: state.profile.id, sort_order: 900,
      }).select().single().then(({ data, error }) => {
        if (error) { setToast(error.message); return; }
        state.admin.classes.push(data);
        state.classes.push(data);
        setToast('Added "' + data.name + '".');
      });
    }
  });

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    switch (action) {
      case "nav-browse": state.view = "browse"; render(); loadClasses(); break;
      case "signout": handleSignOut(); break;
      case "auth-tab-signin": state.authMode = "signin"; state.authError = null; render(); break;
      case "auth-tab-signup": state.authMode = "signup"; state.authError = null; render(); break;
      case "filter-dept": state.classDept = el.dataset.dept; render(); break;
      case "set-access": state.builder.access = el.dataset.access; render(); break;
      case "start-checkout": goToStripe("/api/checkout"); break;
      case "manage-billing": goToStripe("/api/portal"); break;
      case "open-class": {
        const cls = state.classes.find((c) => c.id === el.dataset.id);
        if (cls) openClass(cls);
        break;
      }
      case "back-to-class": state.view = "class"; render(); break;
      case "start-build-test": resetBuilder(); state.view = "build"; render(); break;
      case "discard-generated": resetBuilder(); render(); break;
      case "generate-test": handleGenerate(); break;
      case "remove-generated": removeGenerated(el.dataset.kind, Number(el.dataset.idx)); break;
      case "save-test": {
        const title = document.getElementById("test-title").value.trim();
        saveGeneratedTest(title);
        break;
      }
      case "open-test": {
        const t = state.tests.find((x) => x.id === el.dataset.id);
        if (t) { state.currentTest = t; state.view = "test"; render(); }
        break;
      }
      case "start-study": startQuiz(state.currentTest, "study"); break;
      case "start-test-mode": startQuiz(state.currentTest, "test"); break;
      case "start-flashcards": startFlashcards(state.currentTest); break;
      case "select-choice": {
        const q = state.quiz;
        q.answers[q.questions[q.index]._id] = Number(el.dataset.idx);
        render();
        break;
      }
      case "quiz-check": {
        const q = state.quiz;
        q.revealed[q.questions[q.index]._id] = true;
        render();
        break;
      }
      case "quiz-prev": state.quiz.index = Math.max(0, state.quiz.index - 1); render(); break;
      case "quiz-next": state.quiz.index = Math.min(state.quiz.questions.length - 1, state.quiz.index + 1); render(); break;
      case "quiz-submit": submitQuiz(); break;
      case "close-review": stopTimer(); state.view = "test"; render(); break;
      case "flip-card": state.flash.flipped = !state.flash.flipped; render(); break;
      case "flash-next": {
        const f = state.flash;
        f.index = Math.min(f.cards.length - 1, f.index + 1);
        f.flipped = false; render();
        break;
      }
      case "flash-prev": {
        const f = state.flash;
        f.index = Math.max(0, f.index - 1);
        f.flipped = false; render();
        break;
      }
      case "flash-know": state.flash.know += 1; document.querySelector('[data-action="flash-next"]').click(); break;
      case "flash-learning": state.flash.learning += 1; document.querySelector('[data-action="flash-next"]').click(); break;
      case "flash-shuffle": {
        const f = state.flash;
        f.order = shuffle(f.order);
        f.index = 0; f.flipped = false; render();
        break;
      }
      case "close-flashcards": state.view = "test"; render(); break;
      case "open-subscribe": state.subscribeOpen = true; render(); break;
      case "close-subscribe": state.subscribeOpen = false; render(); break;
      case "close-subscribe-backdrop": if (e.target === el) { state.subscribeOpen = false; render(); } break;
      case "nav-admin": state.view = "admin"; render(); loadAdminData(); break;
      case "admin-import": handleAdminImport(); break;
      case "admin-toggle-free": {
        const id = el.dataset.id;
        const makeFree = el.dataset.free !== "true";
        sb.from("tests").update({ is_free: makeFree }).eq("id", id).select("*, classes(name)").single()
          .then(({ data, error }) => {
            if (!error) {
              const idx = state.admin.tests.findIndex((t) => t.id === id);
              if (idx !== -1) state.admin.tests[idx] = data;
              render();
            } else {
              setToast("Couldn't update that test.");
            }
          });
        break;
      }
      case "admin-toggle-official": {
        const id = el.dataset.id;
        const makeOfficial = el.dataset.official !== "true";
        sb.from("tests").update({ is_official: makeOfficial }).eq("id", id).select("*, classes(name)").single()
          .then(({ data, error }) => {
            if (error) { setToast("Couldn't update that test."); return; }
            const idx = state.admin.tests.findIndex((t) => t.id === id);
            if (idx !== -1) state.admin.tests[idx] = data;
            render();
          });
        break;
      }
      case "admin-delete-test": {
        if (!confirm("Delete this test for everyone? This can't be undone.")) break;
        sb.from("tests").delete().eq("id", el.dataset.id).then(({ error }) => {
          if (!error) { state.admin.tests = state.admin.tests.filter((t) => t.id !== el.dataset.id); render(); }
          else setToast("Couldn't delete that test.");
        });
        break;
      }
      case "admin-delete-class": {
        if (!confirm("Delete this class and every test in it? This can't be undone.")) break;
        sb.from("classes").delete().eq("id", el.dataset.id).then(({ error }) => {
          if (!error) {
            state.admin.classes = state.admin.classes.filter((c) => c.id !== el.dataset.id);
            state.admin.tests = state.admin.tests.filter((t) => t.class_id !== el.dataset.id);
            render();
          } else {
            setToast("Couldn't delete that class.");
          }
        });
        break;
      }
    }
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  sb.auth.onAuthStateChange((_event, session) => {
    state.session = session;
    if (session) {
      loadAfterAuth();
    } else {
      state.view = "auth";
      render();
    }
  });
})();
