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

  // If a student's computer clock is wrong, supabase-js can keep using a login
  // token the server already considers expired. When the database says so,
  // refresh the session once and retry the request.
  let refreshing = null;
  async function resilientFetch(input, init) {
    const res = await fetch(input, init);
    if (res.status !== 401 || !String(input).includes("/rest/v1/")) return res;
    const body = await res.clone().json().catch(() => ({}));
    if (body.code !== "PGRST303" && !/jwt expired/i.test(body.message || "")) return res;
    refreshing = refreshing || sb.auth.refreshSession().finally(() => setTimeout(() => { refreshing = null; }, 2000));
    const { data } = await refreshing;
    if (!data || !data.session) return res;
    const headers = new Headers((init && init.headers) || {});
    headers.set("Authorization", "Bearer " + data.session.access_token);
    return fetch(input, { ...(init || {}), headers });
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    global: { fetch: resilientFetch },
  });

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
    classLevel: "All levels",
    classUnit: "all",
    pins: [],
    mine: null,
    board: null,
    settingsUi: {},
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
      unit: "",
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

  // Toasts live outside #app so re-renders don't restart their animation.
  let toastTimer = null;
  function setToast(msg) {
    state.toast = msg;
    render();
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    if (!msg) { el.classList.remove("show"); return; }
    el.textContent = msg;
    el.classList.remove("show");
    void el.offsetWidth; // restart the slide-in
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove("show"); if (state.toast === msg) state.toast = null; }, 3800);
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
    applyAppearance(state.profile);
    state.view = "browse";
    render();
    loadClasses();
    loadPins();
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
    if (!state.currentClass || state.currentClass.id !== cls.id) state.classUnit = "all";
    state.currentClass = cls;
    state.tests = [];
    state.testsLoaded = false;
    state.view = "class";
    render();
    const [{ data, error }, { data: listing }] = await Promise.all([
      sb.from("tests").select("*, profiles(display_name)").eq("class_id", cls.id).order("created_at", { ascending: false }),
      sb.rpc("class_test_list", { p_class: cls.id }),
    ]);
    if (state.currentClass !== cls) return;
    // Tests this student can't open yet (PrepBank+) come back from the listing
    // with counts only, so they still show up with a lock.
    const readable = new Map((data || []).map((t) => [t.id, t]));
    const stubs = (listing || []).filter((t) => !readable.has(t.id)).map((t) => ({
      ...t,
      questions: [...Array(t.mc_count || 0).fill({ type: "mc" }), ...Array(t.short_count || 0).fill({ type: "short" })],
      flashcards: Array(t.flashcard_count || 0).fill({}),
      profiles: { display_name: t.author },
      preview_only: true,
    }));
    // Official tests first, then newest student tests
    if (!error) { state.tests = [...(data || []), ...stubs].sort((a, b) => (b.is_official ? 1 : 0) - (a.is_official ? 1 : 0)); }
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
        unit: Number.isInteger(parsed.unit) ? parsed.unit : null,
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
        const { data: badName } = await sb.rpc("is_inappropriate", { t: displayName });
        if (badName) throw new Error("That name isn't allowed on PrepBank. Please choose another.");
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
      official: admin, access: "plus", unit: "",
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
    if (b.unit === "") { b.error = "Choose which unit this material is from."; render(); window.scrollTo(0, 0); return; }
    if (!b.material.trim()) { b.error = "Paste or upload some study material first."; render(); return; }
    const total = b.counts.mc + b.counts.short + b.counts.flashcards;
    if (total <= 0) { b.error = "Ask for at least one question or flashcard."; render(); return; }
    b.busy = true;
    render();
    try {
      const resp = await aiFetch({
        action: "generate",
        subject: state.currentClass.subject,
        className: state.currentClass.name,
        material: b.material,
        counts: b.counts,
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
        unit: b.unit === "" ? null : Number(b.unit),
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
      b.error = isFilterError(e)
        ? "Your test wasn't posted because it contains language that isn't allowed on PrepBank. Remove it and try again."
        : e.message || "Couldn't save the test.";
      b.saving = false;
      render();
    }
  }

  // ---------------------------------------------------------------------
  // Quiz (study or timed test mode)
  // ---------------------------------------------------------------------

  function startQuiz(test, mode) {
    if (test.preview_only) { openClass(state.currentClass); return; }
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
    lastProgress = 0;
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
        const resp = await aiFetch({
          action: "grade",
          pairs: shortToGrade.map(({ prompt, expectedAnswer, studentAnswer }) => ({ prompt, expectedAnswer, studentAnswer })),
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
    if (test.preview_only) { openClass(state.currentClass); return; }
    const cards = test.flashcards || [];
    if (cards.length === 0) { setToast("This test has no flashcards."); return; }
    state.flash = { test, cards, order: cards.map((_, i) => i), index: 0, flipped: false, know: 0, learning: 0, done: {} };
    state.view = "flashcards";
    render();
  }

  // ---------------------------------------------------------------------
  // Subscription (placeholder -- swap for real Stripe later, see README)
  // ---------------------------------------------------------------------

  // Calls our /api/ai function as the signed-in user. If the login token has
  // expired (e.g. a wrong device clock), refresh it once and try again.
  async function aiFetch(payload) {
    const send = (token) => fetch("/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(payload),
    });
    let resp = await send(state.session ? state.session.access_token : "");
    if (resp.status === 401) {
      const { data } = await sb.auth.refreshSession();
      if (data && data.session) { state.session = data.session; resp = await send(data.session.access_token); }
    }
    return resp;
  }

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

  // Small inline icon set (stroke icons, inherit currentColor)
  const ICONS = {
    search: '<path d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm10 2-4.35-4.35"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    back: '<path d="m15 6-6 6 6 6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M4 19a2 2 0 0 1 2-2h13"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
    cards: '<rect x="3" y="6" width="14" height="14" rx="2"/><path d="M7 2h12a2 2 0 0 1 2 2v12"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
    upload: '<path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/>',
    pin: '<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  };
  function icon(name, cls) {
    return `<svg class="icon ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  // Animation bookkeeping: only play entrance animations when the screen
  // actually changes, not on every re-render.
  let lastViewKey = null;
  let lastModalOpen = false;
  let lastFlashIndex = null;
  let lastProgress = 0;

  function viewKey() {
    if (!state.session) return "auth-" + state.authMode;
    return [state.view, state.currentClass && state.currentClass.id, state.currentTest && state.currentTest.id,
      state.view === "quiz" && state.quiz ? state.quiz.index : "", state.view === "build" && state.builder.generated ? "preview" : ""].join("|");
  }

  function render() {
    const app = document.getElementById("app");
    const key = viewKey();
    const entering = key !== lastViewKey;
    lastViewKey = key;
    app.innerHTML = shell(entering);
    lastModalOpen = !!state.subscribeOpen;
    attachDynamicListeners();
    afterRender(entering);
  }

  function afterRender(entering) {
    // Progress bar: start from the previous width so it slides forward
    const bar = document.querySelector(".progressbar > div[data-to]");
    if (bar) requestAnimationFrame(() => { bar.style.width = bar.dataset.to + "%"; lastProgress = Number(bar.dataset.to); });
    // Score count-up on the results screen
    const scoreEl = document.querySelector("[data-countup]");
    if (scoreEl && entering) {
      const target = Number(scoreEl.dataset.countup), total = scoreEl.dataset.total;
      const start = performance.now(), dur = 900;
      const tick = (now) => {
        const t = Math.min(1, (now - start) / dur), eased = 1 - Math.pow(1 - t, 3);
        scoreEl.textContent = Math.round(target * eased) + "/" + total;
        if (t < 1) requestAnimationFrame(tick);
      };
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) requestAnimationFrame(tick);
    }
  }

  function initials(name) {
    return String(name || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  }

  function brandMark() {
    return `<span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8"/><path d="M11 23V9h6.2a4.3 4.3 0 0 1 0 8.6H11" /></svg></span>`;
  }

  function shell(entering) {
    if (!state.session) return authScreen(entering);
    const name = state.profile ? state.profile.display_name : "";
    const planLabel = isAdmin() ? "Admin" : hasPlus() ? "PrepBank+" : "Upgrade";
    const nav = `
      <header class="topbar"><div class="topbar-inner">
        <a href="#" class="brand" data-action="nav-browse">${brandMark()}<span>PrepBank</span></a>
        <nav class="topnav">
          <button data-action="nav-browse" class="${["browse", "class", "build", "test", "quiz", "review", "flashcards"].includes(state.view) ? "active" : ""}">Classes</button>
          <button data-action="nav-mytests" class="${state.view === "mytests" ? "active" : ""}">My tests</button>
          <button data-action="nav-leaderboard" class="${state.view === "leaderboard" ? "active" : ""}">Leaderboard</button>
          ${isAdmin() ? `<button data-action="nav-admin" class="${state.view === "admin" ? "active" : ""}">Admin</button>` : ""}
        </nav>
        <div class="top-right">
          <button class="plan-pill ${hasPlus() ? "plus" : ""}" data-action="open-subscribe">${hasPlus() ? icon("spark") : ""}${planLabel}</button>
          <button class="user-chip ${state.view === "settings" ? "active" : ""}" data-action="nav-settings" title="Settings">${avatarHtml(state.profile, 30)}<span class="user-name">${esc(name)}</span>${icon("gear", "gear")}</button>
        </div>
      </div></header>`;
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
      case "mytests": body = myTestsView(); break;
      case "leaderboard": body = leaderboardView(); break;
      case "settings": body = settingsView(); break;
      default: body = skeletonRows();
    }
    const wide = ["browse", "admin", "settings"].includes(state.view);
    return `<div class="shell">${nav}<main class="${wide ? "wide" : ""} ${entering ? "view-enter" : ""}">${body}</main>${footer()}</div>
      ${state.subscribeOpen ? subscribeModal(!lastModalOpen) : ""}`;
  }

  function skeletonRows() {
    return `<div class="skeleton-list">${Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join("")}</div>`;
  }

  function footer() {
    return `<footer class="site-footer"><div>${brandMark()} PrepBank</div><p>Made by students at Highland Park High School. Practice tests are AI-generated from material classmates share, so check anything important against your own notes before an exam. Independent student project, not affiliated with Highland Park ISD.</p><nav class="footer-links"><a href="/terms.html">Terms &amp; Privacy</a><a href="/terms.html#billing">Refunds</a><a href="mailto:inmanwill12@yahoo.com">Contact</a></nav></footer>`;
  }

  function authScreen(entering) {
    const signup = state.authMode === "signup";
    return `<div class="shell auth-shell">
      <header class="topbar"><div class="topbar-inner"><span class="brand">${brandMark()}<span>PrepBank</span></span></div></header>
      <main class="auth-main ${entering ? "view-enter" : ""}">
        <section class="auth-hero">
          <div class="eyebrow">Highland Park High School &middot; 2026&ndash;27</div>
          <h1>Practice tests built from what your class is actually learning.</h1>
          <p class="lede">Share your teacher's study guide once and PrepBank turns it into multiple choice, short answer and flashcards for everyone in that class.</p>
          <ul class="auth-points">
            <li>${icon("book")}<span><strong>95 HPHS courses</strong> from English I to AP Physics C</span></li>
            <li>${icon("timer")}<span><strong>Timed test mode</strong> with AI-graded short answers</span></li>
            <li>${icon("shield")}<span><strong>Official tests</strong> checked and published by PrepBank</span></li>
          </ul>
        </section>
        <section class="card auth-card">
          <div class="seg seg-full" role="tablist">
            <button class="${!signup ? "on" : ""}" data-action="auth-tab-signin" role="tab">Sign in</button>
            <button class="${signup ? "on" : ""}" data-action="auth-tab-signup" role="tab">Create account</button>
          </div>
          <h2>${signup ? "Create your account" : "Welcome back"}</h2>
          ${state.authError ? `<div class="error-box">${esc(state.authError)}</div>` : ""}
          <form id="auth-form">
            ${signup ? `<div class="field"><label for="display_name">Your name</label><input type="text" id="display_name" name="display_name" placeholder="How classmates will see you" required /></div>` : ""}
            <div class="field"><label for="email">School email</label><input type="email" id="email" name="email" autocomplete="email" required /></div>
            <div class="field"><label for="password">Password</label><input type="password" id="password" name="password" minlength="6" autocomplete="${signup ? "new-password" : "current-password"}" required /></div>
            <button class="btn primary block lg" type="submit" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? '<span class="spinner"></span> Please wait' : signup ? "Create account" : "Sign in"}</button>
          </form>
        </section>
      </main>
      ${footer()}
    </div>`;
  }

  const LEVELS = ["All levels", "On-Level", "Honors", "AP", "Electives"];

  function levelTag(level) {
    if (!level) return "";
    const cls = level === "AP" || level === "Dual Credit" ? "level-ap" : level === "Honors" ? "level-honors" : level === "Elective" ? "level-elective" : "level-on";
    return `<span class="level ${cls}">${esc(level === "On-Level" ? "On-level" : level)}</span>`;
  }

  function filteredClasses(ignoreDept) {
    const q = state.classQuery.trim().toLowerCase();
    // Let "apush", "calc bc", "apwh" style searches still match
    const aliases = { apush: "united states history", apwh: "ap world history", apgov: "united states government", apes: "environmental science", aphug: "human geography", calc: "calcul", precalc: "pre-calculus", chem: "chem", bio: "biolog", gov: "government", us: "united states", csa: "computer science a", apcsp: "ap computer science principles", psych: "psycholog", econ: "econom", lang: "language", lit: "literature" };
    const terms = q.split(/\s+/).filter(Boolean).map((t) => aliases[t] || t);
    const lvl = state.classLevel || "All levels";
    return state.classes.filter((c) => {
      if (!ignoreDept && state.classDept !== "All" && c.subject !== state.classDept) return false;
      if (lvl === "AP" && !(c.level === "AP" || c.level === "Dual Credit")) return false;
      if (lvl === "Electives" && c.level !== "Elective") return false;
      if ((lvl === "On-Level" || lvl === "Honors") && c.level !== lvl) return false;
      const hay = `${c.name} ${c.subject} ${c.level || ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  function classRow(c) {
    const n = state.classCounts[c.id] || { test_count: 0, official_count: 0 };
    return `<button class="class-row" data-action="open-class" data-id="${c.id}">
      <span class="class-name">${esc(c.name)}</span>
      <span class="class-level">${levelTag(c.level)}</span>
      <span class="class-tests ${n.test_count ? "has" : ""}">${n.official_count ? `<span class="dot-official" title="Has official tests">${icon("check")}</span>` : ""}<span class="num">${n.test_count}</span> ${n.test_count === 1 ? "test" : "tests"}</span>
      ${icon("chevron", "row-chevron")}
    </button>`;
  }

  function classResults() {
    const list = filteredClasses();
    if (list.length === 0) {
      return `<div class="empty-state">${icon("search")}<h3>No classes match "${esc(state.classQuery)}"</h3><p>Every HPHS course is already listed. Try a shorter search like "chem" or "AP", or clear the filters.</p><button class="btn small" data-action="clear-filters">Clear search and filters</button></div>`;
    }
    const groups = {};
    list.forEach((c) => { (groups[c.subject] = groups[c.subject] || []).push(c); });
    return Object.entries(groups).map(([dept, classes]) => `
      <section class="catalog-group">
        <header class="catalog-head"><h3>${esc(dept)}</h3><span class="count">${classes.length} ${classes.length === 1 ? "course" : "courses"}</span></header>
        <div class="catalog-list">${classes.map(classRow).join("")}</div>
      </section>`).join("");
  }

  function deptCounts() {
    const base = filteredClasses(true);
    const counts = { All: base.length };
    base.forEach((c) => { counts[c.subject] = (counts[c.subject] || 0) + 1; });
    return counts;
  }

  function deptRail() {
    const counts = deptCounts();
    return DEPARTMENTS.map((d) => `<button class="dept-item ${state.classDept === d ? "on" : ""}" data-action="filter-dept" data-dept="${esc(d)}">
      <span>${d === "All" ? "All departments" : esc(d)}</span><span class="num">${counts[d] || 0}</span></button>`).join("");
  }

  function browseExtras() {
    const filtering = state.classQuery || state.classDept !== "All" || (state.classLevel && state.classLevel !== "All levels");
    if (filtering) return "";
    const popular = state.classes
      .filter((c) => (state.classCounts[c.id] || {}).test_count)
      .sort((a, b) => state.classCounts[b.id].test_count - state.classCounts[a.id].test_count)
      .slice(0, 4);
    return `
      ${pinnedSection()}
      ${popular.length ? `
        <section class="popular">
          <div class="section-label">Most practiced right now</div>
          <div class="popular-grid">
            ${popular.map((c) => `<button class="popular-card" data-action="open-class" data-id="${c.id}">
              <span class="pc-dept">${esc(c.subject)}</span>
              <span class="pc-name">${esc(c.name)}</span>
              <span class="pc-count"><span class="num">${state.classCounts[c.id].test_count}</span> practice tests</span>
            </button>`).join("")}
          </div>
        </section>` : ""}`;
  }

  function browseView() {
    if (!state.classesLoaded) return skeletonRows();
    return `
      <div class="page-head">
        <div class="eyebrow">Highland Park High School &middot; Course catalog</div>
        <h1>Find your class</h1>
        <p class="sub">${state.classes.length} courses that involve real studying. Open yours to practice, or add your study guide so everyone in the class can use it.</p>
      </div>
      <div id="browse-extras">${browseExtras()}</div>
      <div class="catalog">
        <aside class="dept-rail" id="dept-rail" aria-label="Departments">${deptRail()}</aside>
        <div class="catalog-main">
          <div class="catalog-tools">
            <label class="searchbox" for="class-search">${icon("search")}
              <input type="text" id="class-search" placeholder="Search courses, e.g. AP Bio, Chem Honors, APUSH" value="${esc(state.classQuery)}" autocomplete="off" />
              <kbd>/</kbd>
            </label>
            <div class="seg level-seg" role="tablist" aria-label="Course level">
              ${LEVELS.map((l) => `<button class="${(state.classLevel || "All levels") === l ? "on" : ""}" data-action="filter-level" data-level="${esc(l)}">${esc(l)}</button>`).join("")}
            </div>
          </div>
          <div id="class-results">${classResults()}</div>
        </div>
      </div>
    `;
  }

  function crumbs(parts) {
    return `<nav class="crumbs" aria-label="Breadcrumb">${parts.map((p, i) => i < parts.length - 1
      ? `<button data-action="${p.action}">${i === 0 ? icon("back") : ""}${esc(p.label)}</button><span class="sep">/</span>`
      : `<span class="current">${esc(p.label)}</span>`).join("")}</nav>`;
  }

  function testRow(t) {
    const locked = testIsLocked(t);
    const author = t.profiles && t.profiles.display_name;
    const fc = (t.flashcards || []).length;
    return `<div class="test-row ${t.is_official ? "official" : "student"} ${locked ? "locked" : ""}" role="button" tabindex="0" data-action="open-test" data-id="${t.id}">
      <span class="tr-main">
        <span class="test-badges">
          ${t.is_official ? `<span class="badge-official">${icon("check")}Official</span>` : '<span class="badge-student">Student-made</span>'}
          ${t.is_free ? '<span class="badge-free">Free</span>' : ""}
        </span>
        <span class="tr-title">${esc(t.title)}</span>
        <span class="meta"><span class="num">${t.question_count}</span> questions${fc ? ` &middot; <span class="num">${fc}</span> flashcards` : ""}${!t.is_official && author ? ` &middot; shared by ${esc(author)}` : ""}</span>
      </span>
      <span class="tr-side">${pinButton("test", t.id, true)}${locked ? `<span class="lock">${icon("lock")}PrepBank+</span>` : `<span class="tr-open">Open${icon("chevron")}</span>`}</span>
    </div>`;
  }

  function classView() {
    const c = state.currentClass;
    if (!c) return "";
    const official = state.tests.filter((t) => t.is_official);
    const student = state.tests.filter((t) => !t.is_official);
    const addLabel = isAdmin() ? "Publish an official test" : "Add your study guide";
    let body;
    if (!state.testsLoaded) body = skeletonRows();
    else if (state.tests.length === 0) body = `<div class="empty-state">${icon("upload")}
        <h3>No practice tests for ${esc(c.name)} yet</h3>
        <p>Add your study guide, notes or review sheet and PrepBank turns it into the first practice test for this class. The first one is free for everyone.</p>
        <button class="btn ${isAdmin() ? "primary" : "gold"}" data-action="start-build-test">${icon("upload")}${addLabel}</button></div>`;
    else {
      const key = (t) => (t.unit === null || t.unit === undefined ? -1 : t.unit);
      const units = [...new Set(state.tests.map(key))].sort((a, b) => (a < 0) - (b < 0) || a - b);
      const shown = state.classUnit === "all" ? units : units.filter((u) => String(u) === String(state.classUnit));
      const chips = units.length > 1 ? `<div class="seg unit-chips" role="group" aria-label="Filter by unit">
          <button class="chip ${state.classUnit === "all" ? "on" : ""}" data-action="filter-unit" data-unit="all">All units</button>
          ${units.map((u) => `<button class="chip ${String(state.classUnit) === String(u) ? "on" : ""}" data-action="filter-unit" data-unit="${u}">${esc(unitLabel(u))}</button>`).join("")}
        </div>` : "";
      body = chips + shown.map((u) => {
        const list = state.tests.filter((t) => key(t) === u).sort((a, b) => (b.is_official ? 1 : 0) - (a.is_official ? 1 : 0));
        return `<section class="test-group unit-group"><div class="unit-head"><h2>${esc(unitLabel(u))}</h2><span class="count">${list.length} ${list.length === 1 ? "test" : "tests"}</span></div><div class="stagger">${list.map(testRow).join("")}</div></section>`;
      }).join("");
    }
    return `
      ${crumbs([{ label: "Classes", action: "nav-browse" }, { label: c.subject, action: "nav-browse" }, { label: c.name }])}
      <div class="page-head row">
        <div>
          <div class="eyebrow">${esc(c.subject)} ${levelTag(c.level)}</div>
          <h1>${esc(c.name)}</h1>
          <p class="sub">${state.testsLoaded ? `<span class="num">${state.tests.length}</span> practice ${state.tests.length === 1 ? "test" : "tests"}${official.length ? ` &middot; <span class="num">${official.length}</span> official` : ""}` : "&nbsp;"}</p>
        </div>
        <div class="head-actions">${pinButton("class", c.id)}<button class="btn ${isAdmin() ? "primary" : "gold"}" data-action="start-build-test">${icon("upload")}${addLabel}</button></div>
      </div>
      ${body}
    `;
  }

  function buildView() {
    const b = state.builder;
    if (b.generated) return buildPreview();
    const admin = isAdmin();
    const c = state.currentClass;
    const header = admin ? `
      <div class="page-head">
        <div class="eyebrow"><span class="badge-official">${icon("check")}Official</span> Publishing as admin</div>
        <h1>Publish an official test</h1>
        <p class="sub">Official tests are pinned to the top of ${esc(c.name)} with a checkmark. You choose whether they're free or PrepBank+.</p>
      </div>
      <div class="card option-card">
        <label class="switch-row" for="opt-official">
          <span><strong>Official PrepBank test</strong><span class="help">Shows the checkmark badge and pins it to the top</span></span>
          <input type="checkbox" id="opt-official" class="switch" ${b.official ? "checked" : ""} />
        </label>
        <div class="option-divider"></div>
        <div class="option-row">
          <span><strong>Who can take it</strong></span>
          <div class="seg">
            <button class="${b.access === "free" ? "on" : ""}" data-action="set-access" data-access="free">Free for everyone</button>
            <button class="${b.access === "plus" ? "on" : ""}" data-action="set-access" data-access="plus">${icon("lock")}PrepBank+ only</button>
          </div>
        </div>
      </div>` : `
      <div class="page-head">
        <div class="eyebrow">${esc(c.name)}</div>
        <h1>Add your study guide</h1>
        <p class="sub">Share what your teacher gave you (a review sheet, notes or a study guide) and PrepBank turns it into practice questions and flashcards for everyone in the class.</p>
      </div>
      <div class="notice">
        ${icon("users")}
        <div><strong>Your test will be labeled Student-made and credit you by name.</strong>
        Only share material from this class. Don't upload real tests, quizzes or answer keys; admins remove them.
        ${state.tests.length === 0 ? " Since this is the first test in the class, it'll be free for everyone." : ""}</div>
      </div>`;
    return `
      ${crumbs([{ label: "Classes", action: "nav-browse" }, { label: c.name, action: "back-to-class" }, { label: admin ? "Publish" : "Add study guide" }])}
      ${header}
      ${b.error ? `<div class="error-box">${esc(b.error)}</div>` : ""}
      <div class="card builder-card ${admin ? "admin-card" : ""} ${b.busy ? "is-busy" : ""}">
        <div class="field unit-field">
          <label for="unit-select">Unit</label>
          <select id="unit-select" required>
            <option value="" ${b.unit === "" ? "selected" : ""}>Choose the unit this material is from</option>
            ${Array.from({ length: 16 }, (_, i) => `<option value="${i}" ${String(b.unit) === String(i) ? "selected" : ""}>Unit ${i}</option>`).join("")}
          </select>
          <p class="help">Keep each unit separate. If your material covers two units, make a test for each.</p>
        </div>
        <div class="field">
          <div class="label-row"><label for="material">Study material</label><span class="help num" id="char-count">${b.material.length.toLocaleString()} characters</span></div>
          <textarea id="material" placeholder="Paste your study guide, notes or your teacher's review sheet here">${esc(b.material)}</textarea>
        </div>
        <label class="dropzone" for="file-upload">
          ${icon("upload")}
          <span><strong>Upload a file</strong> or drag it here</span>
          <span class="help">.txt or .pdf with selectable text (not a scanned photo)</span>
          <input type="file" id="file-upload" accept=".txt,.pdf,text/plain,application/pdf" />
        </label>
        <div class="count-inputs">
          <div class="field"><label for="count-mc">Multiple choice</label><input type="number" id="count-mc" min="0" max="25" value="${b.counts.mc}" /></div>
          <div class="field"><label for="count-short">Short answer</label><input type="number" id="count-short" min="0" max="25" value="${b.counts.short}" /></div>
          <div class="field"><label for="count-flash">Flashcards</label><input type="number" id="count-flash" min="0" max="40" value="${b.counts.flashcards}" /></div>
        </div>
        <div class="builder-actions">
          <button class="btn ${admin ? "primary" : "gold"} lg" data-action="generate-test" ${b.busy ? "disabled" : ""}>${b.busy ? '<span class="spinner"></span> Writing questions&hellip;' : `${icon("spark")}${admin ? "Generate official test" : "Generate practice test"}`}</button>
          ${b.busy ? '<span class="help">This usually takes 15 to 40 seconds.</span>' : ""}
        </div>
        ${b.busy ? '<div class="busy-bar"><div></div></div>' : ""}
      </div>
      ${admin ? `<p class="help tip">Tip: you can also send study material to Claude in chat and paste the result into Admin &rarr; Import.</p>` : ""}
    `;
  }

  function buildPreview() {
    const b = state.builder;
    const g = b.generated;
    const item = (kind, i, title, body) => `
      <div class="preview-item">
        <div class="pi-head"><span class="pi-title">${title}</span>
          <button class="btn ghost small" data-action="remove-generated" data-kind="${kind}" data-idx="${i}">Remove</button></div>
        ${body}
      </div>`;
    const mcHtml = g.mc.map((q, i) => item("mc", i, `<span class="num">${i + 1}.</span> ${esc(q.prompt)}`,
      `<ol class="pi-choices">${(q.choices || []).map((c, ci) => `<li class="${ci === q.correctIndex ? "correct" : ""}"><span class="choice-letter">${"ABCD"[ci] || ""}</span>${esc(c)}</li>`).join("")}</ol>`)).join("");
    const shortHtml = g.short.map((q, i) => item("short", i, `<span class="num">${i + 1}.</span> ${esc(q.prompt)}`,
      `<div class="help"><strong>Expected:</strong> ${esc(q.answer)}</div>`)).join("");
    const flashHtml = g.flashcards.map((f, i) => item("flashcards", i, esc(f.term), `<div class="help">${esc(f.definition)}</div>`)).join("");
    return `
      ${crumbs([{ label: "Classes", action: "nav-browse" }, { label: state.currentClass.name, action: "back-to-class" }, { label: "Review" }])}
      <div class="page-head">
        <div class="eyebrow">Step 2 of 2 &middot; ${esc(unitLabel(b.unit === "" ? null : Number(b.unit)))}</div>
        <h1>Review before ${isAdmin() ? "publishing" : "sharing"}</h1>
        <p class="sub">Remove anything that looks wrong before your classmates see it.</p>
      </div>
      ${b.error ? `<div class="error-box">${esc(b.error)}</div>` : ""}
      <div class="card save-card">
        <div class="field"><label for="test-title">Test title</label><input type="text" id="test-title" placeholder="e.g. Unit 3: Cellular Energetics" value="${esc(state.currentClass.name + " Practice Test")}" /></div>
        ${isAdmin() ? `<p class="help">Publishing as ${b.official ? "<strong>Official</strong>" : "a regular test"} &middot; ${b.access === "free" ? "Free for everyone" : "PrepBank+ only"}</p>` : ""}
        <div class="builder-actions">
          <button class="btn primary lg" data-action="save-test" ${b.saving ? "disabled" : ""}>${b.saving ? '<span class="spinner"></span> Saving' : isAdmin() ? "Publish to class" : "Share with my class"}</button>
          <button class="btn ghost" data-action="discard-generated">Start over</button>
        </div>
      </div>
      ${g.mc.length ? `<section class="preview-group"><div class="section-label">Multiple choice <span class="num">${g.mc.length}</span></div><div class="card flush">${mcHtml}</div></section>` : ""}
      ${g.short.length ? `<section class="preview-group"><div class="section-label">Short answer <span class="num">${g.short.length}</span></div><div class="card flush">${shortHtml}</div></section>` : ""}
      ${g.flashcards.length ? `<section class="preview-group"><div class="section-label">Flashcards <span class="num">${g.flashcards.length}</span></div><div class="card flush">${flashHtml}</div></section>` : ""}
    `;
  }

  function testView() {
    const t = state.currentTest;
    if (!t) return "";
    const locked = testIsLocked(t);
    const mc = (t.questions || []).filter((q) => q.type === "mc").length;
    const short = (t.questions || []).filter((q) => q.type === "short").length;
    const fc = (t.flashcards || []).length;
    const minutes = Math.max(2, Math.round((mc * 40 + short * 70) / 60));
    const author = t.profiles && t.profiles.display_name;
    const mode = (action, ic, title, desc, meta, primary) => `
      <button class="mode-card ${primary ? "primary" : ""}" data-action="${action}">
        <span class="mode-icon">${icon(ic)}</span>
        <span class="mode-title">${title}</span>
        <span class="mode-desc">${desc}</span>
        <span class="mode-meta"><span>${meta}</span>${icon("chevron")}</span>
      </button>`;
    return `
      ${crumbs([{ label: "Classes", action: "nav-browse" }, { label: state.currentClass.name, action: "back-to-class" }, { label: t.title }])}
      <div class="page-head">
        <div class="eyebrow">${esc(unitLabel(t.unit))} ${t.is_official ? `<span class="badge-official">${icon("check")}Official PrepBank</span>` : `<span class="badge-student">Student-made${author ? " &middot; shared by " + esc(author) : ""}</span>`}</div>
        <div class="title-row"><h1>${esc(t.title)}</h1>${pinButton("test", t.id)}</div>
        <div class="stat-row">
          <span><span class="num">${mc}</span> multiple choice</span>
          <span><span class="num">${short}</span> short answer</span>
          <span><span class="num">${fc}</span> flashcards</span>
        </div>
        ${!t.is_official ? `<p class="help">Made from a classmate's study material. Double-check anything that looks off against your notes.</p>` : ""}
      </div>
      ${locked ? `
        <div class="card locked-card">
          <span class="mode-icon gold">${icon("lock")}</span>
          <div><h3>This test is part of PrepBank+</h3><p class="help">Unlock it and every other test in every HPHS class for $3 a month.</p></div>
          <button class="btn gold" data-action="open-subscribe">Unlock PrepBank+</button>
        </div>` : `
        <div class="mode-grid stagger">
          ${mc + short ? mode("start-study", "book", "Study mode", "Go at your own pace and see the answer and explanation after each question.", "Untimed", true) : ""}
          ${mc + short ? mode("start-test-mode", "timer", "Test mode", "Timed like the real thing. Answers stay hidden until you submit.", `About <span class="num">${minutes}</span> min`) : ""}
          ${fc ? mode("start-flashcards", "cards", "Flashcards", "Flip through terms and definitions and track what you know.", `<span class="num">${fc}</span> cards`) : ""}
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
      body = `<div class="choices">${(question.choices || []).map((c, i) => {
        let cls = "choice";
        if (String(given) === String(i)) cls += " selected";
        if (revealed) {
          if (i === question.correctIndex) cls += " correct";
          else if (String(given) === String(i)) cls += " incorrect";
        }
        return `<button class="${cls}" data-action="select-choice" data-idx="${i}" ${revealed ? "disabled" : ""}>
          <span class="choice-letter">${"ABCDEF"[i]}</span>
          <span class="choice-text">${esc(c)}</span>
          ${revealed && i === question.correctIndex ? icon("check", "choice-mark") : ""}
        </button>`;
      }).join("")}</div>`;
    } else {
      body = `<textarea id="short-answer-input" class="answer-box" placeholder="Type your answer">${esc(given || "")}</textarea>`;
    }

    const showCheck = q.mode === "study" && !revealed;
    const right = question.type === "mc" && String(given) === String(question.correctIndex);
    const feedback = q.mode === "study" && revealed ? `
      <div class="feedback ${question.type === "mc" ? (right ? "good" : "bad") : "neutral"}">
        ${question.type === "mc" ? `<strong>${right ? "Correct." : "Not quite."}</strong> ${esc(question.explanation || "")}` : `<strong>Expected answer:</strong> ${esc(question.answer)}`}
      </div>` : "";

    return `
      <div class="quiz-top">
        <button class="btn ghost small" data-action="close-review">${icon("back")}Exit</button>
        <span class="meta">Question <span class="num">${q.index + 1}</span> of <span class="num">${q.questions.length}</span> &middot; ${q.mode === "test" ? "Test mode" : "Study mode"}</span>
        ${q.mode === "test" ? `<span id="quiz-timer" class="timer ${q.remainingSec <= 30 ? "low" : ""}">${formatTime(q.remainingSec)}</span>` : "<span></span>"}
      </div>
      <div class="progressbar"><div style="width:${lastProgress}%" data-to="${pct}"></div></div>
      <div class="card question-card">
        <div class="q-type">${question.type === "mc" ? "Multiple choice" : "Short answer"}</div>
        <h2 class="q-prompt">${esc(question.prompt)}</h2>
        ${body}
        ${feedback}
      </div>
      <div class="quiz-nav">
        <button class="btn" data-action="quiz-prev" ${q.index === 0 ? "disabled" : ""}>${icon("back")}Back</button>
        ${showCheck ? `<button class="btn primary" data-action="quiz-check">Check answer</button>` : ""}
        ${!showCheck && !isLast ? `<button class="btn primary" data-action="quiz-next">Next${icon("chevron")}</button>` : ""}
        ${!showCheck && isLast ? `<button class="btn gold" data-action="quiz-submit" ${q.submitting ? "disabled" : ""}>${q.submitting ? '<span class="spinner"></span> Grading' : q.mode === "test" ? "Submit test" : "Finish"}</button>` : ""}
      </div>
    `;
  }

  function reviewView() {
    const q = state.quiz;
    const r = q.result;
    const pct = r.total ? Math.round((r.correctCount / r.total) * 100) : 0;
    const C = 2 * Math.PI * 52;
    const verdict = pct >= 90 ? "Excellent work" : pct >= 75 ? "Solid" : pct >= 50 ? "Getting there" : "Keep practicing";
    const items = q.questions.map((question, idx) => {
      const p = r.perQuestion.find((x) => x.id === question._id);
      const correct = !!p.correct;
      return `<div class="review-item ${correct ? "is-correct" : "is-wrong"}">
        <span class="verdict-dot">${correct ? icon("check") : "&times;"}</span>
        <div>
          <div class="ri-prompt"><span class="num">${idx + 1}.</span> ${esc(question.prompt)}</div>
          ${question.type === "mc" ? `
            <div class="ri-line"><span>Your answer</span>${p.given != null ? esc(question.choices[p.given]) : "(no answer)"}</div>
            ${!correct ? `<div class="ri-line good"><span>Correct</span>${esc(question.choices[question.correctIndex])}</div>` : ""}
            ${question.explanation ? `<div class="help">${esc(question.explanation)}</div>` : ""}
          ` : `
            <div class="ri-line"><span>Your answer</span>${esc(p.given || "(no answer)")}</div>
            <div class="ri-line good"><span>Expected</span>${esc(question.answer)}</div>
            ${p.feedback ? `<div class="help">${esc(p.feedback)}</div>` : ""}
          `}
        </div>
      </div>`;
    }).join("");
    return `
      <div class="card score-card">
        <div class="ring" style="--dash:${C.toFixed(1)};--off:${(C * (1 - pct / 100)).toFixed(1)}">
          <svg viewBox="0 0 120 120"><circle class="ring-bg" cx="60" cy="60" r="52"/><circle class="ring-fg ${pct >= 75 ? "good" : pct >= 50 ? "mid" : "low"}" cx="60" cy="60" r="52"/></svg>
          <div class="ring-label"><span class="num">${pct}%</span></div>
        </div>
        <div>
          <div class="eyebrow">${state.quiz.mode === "test" ? "Test mode" : "Study mode"} &middot; ${esc(q.test.title)}</div>
          <h1>${verdict}</h1>
          <p class="score-line"><span class="num" data-countup="${r.correctCount}" data-total="${r.total}">${r.correctCount}/${r.total}</span> correct</p>
          <div class="builder-actions">
            <button class="btn primary" data-action="retry-quiz">Try again</button>
            <button class="btn" data-action="close-review">Back to test</button>
          </div>
        </div>
      </div>
      <div class="section-label">Question review</div>
      <div class="card flush">${items}</div>
    `;
  }

  function flashcardsView() {
    const f = state.flash;
    const card = f.cards[f.order[f.index]];
    const entering = lastFlashIndex !== f.index;
    lastFlashIndex = f.index;
    const done = f.know + f.learning;
    return `
      ${crumbs([{ label: state.currentClass.name, action: "back-to-class" }, { label: f.test.title, action: "close-flashcards" }, { label: "Flashcards" }])}
      <div class="flash-stats">
        <span>Card <span class="num">${f.index + 1}</span> of <span class="num">${f.cards.length}</span></span>
        <span class="fs-know">${icon("check")}Know it <span class="num">${f.know}</span></span>
        <span class="fs-learn">Still learning <span class="num">${f.learning}</span></span>
      </div>
      <div class="progressbar thin"><div style="width:${Math.round((done / f.cards.length) * 100)}%"></div></div>
      <div class="flashcard-wrap">
        <button class="flashcard ${f.flipped ? "flipped" : ""} ${entering ? "fc-enter" : ""}" data-action="flip-card" aria-label="Flip card">
          <span class="fc-inner">
            <span class="fc-face fc-front"><span class="side-label">Term</span><span class="fc-text">${esc(card.term)}</span><span class="fc-hint">Click or press space to flip</span></span>
            <span class="fc-face fc-back"><span class="side-label">Definition</span><span class="fc-text small">${esc(card.definition)}</span></span>
          </span>
        </button>
      </div>
      <div class="flashcard-controls">
        <button class="btn icon-btn" data-action="flash-prev" aria-label="Previous card">${icon("back")}</button>
        <button class="btn learn" data-action="flash-learning">Still learning</button>
        <button class="btn know" data-action="flash-know">${icon("check")}Know it</button>
        <button class="btn icon-btn" data-action="flash-next" aria-label="Next card">${icon("chevron")}</button>
      </div>
      <div class="center"><button class="btn ghost small" data-action="flash-shuffle">Shuffle deck</button></div>
    `;
  }

  function subscribeModal(animate) {
    const perk = (t) => `<li>${icon("check")}<span>${t}</span></li>`;
    return `<div class="modal-backdrop ${animate ? "animate" : ""}" data-action="close-subscribe-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="plus-title">
        <div class="modal-badge">${icon("spark")}</div>
        <h2 id="plus-title">PrepBank+</h2>
        ${isAdmin() ? `<p class="help">You're an admin, so every test is already unlocked for you.</p>` : isSubscribed() ? `
          <p>You have PrepBank+. Every practice test in every class is unlocked.</p>
          ${state.subscription.current_period_end ? `<p class="help">Renews on ${new Date(state.subscription.current_period_end).toLocaleDateString()}.</p>` : ""}
          <button class="btn block" data-action="manage-billing" ${state.subscribeBusy ? "disabled" : ""}>${state.subscribeBusy ? '<span class="spinner"></span> Opening' : "Manage or cancel subscription"}</button>` : `
          <div class="price-line"><span class="price">$3</span><span class="help">per month &middot; cancel anytime</span></div>
          <ul class="perks">
            ${perk("Every official PrepBank test for every HPHS class")}
            ${perk("Every test your classmates have shared")}
            ${perk("Timed test mode, AI-graded short answers and flashcards")}
          </ul>
          <button class="btn gold block lg" data-action="start-checkout" ${state.subscribeBusy ? "disabled" : ""}>${state.subscribeBusy ? '<span class="spinner"></span> Opening checkout' : "Get PrepBank+"}</button>
          <p class="help center">Secure checkout by Stripe. Renews monthly until you cancel; no refunds for partial months. Under 18? Ask a parent first. <a href="/terms.html#billing" target="_blank" rel="noopener">Terms</a></p>`}
        <button class="btn ghost block" data-action="close-subscribe">Close</button>
      </div>
    </div>`;
  }

  function adminView() {
    const a = state.admin;
    if (!a.loaded) return skeletonRows();
    const officialCount = a.tests.filter((t) => t.is_official).length;
    const testsRows = a.tests.map((t) => `
      <div class="admin-test ${t.is_official ? "official" : "student"}">
        <div class="at-main">
          <div class="test-badges">${t.is_official ? `<span class="badge-official">${icon("check")}Official</span>` : '<span class="badge-student">Student-made</span>'} ${t.is_free ? '<span class="badge-free">Free</span>' : `<span class="badge-plus">${icon("lock")}PrepBank+</span>`}</div>
          <div class="tr-title">${esc(t.title)}</div>
          <div class="meta">${esc(t.classes ? t.classes.name : "")} &middot; <span class="num">${t.question_count}</span> questions &middot; <span class="num">${(t.flashcards || []).length}</span> flashcards</div>
        </div>
        <div class="at-actions">
          <select class="unit-mini" data-unit-for="${t.id}" aria-label="Unit">${[`<option value="">No unit</option>`].concat(Array.from({ length: 16 }, (_, i) => `<option value="${i}" ${t.unit === i ? "selected" : ""}>Unit ${i}</option>`)).join("")}</select>
          <button class="btn small" data-action="admin-toggle-official" data-id="${t.id}" data-official="${t.is_official}">${t.is_official ? "Remove Official" : "Make Official"}</button>
          <button class="btn small" data-action="admin-toggle-free" data-id="${t.id}" data-free="${t.is_free}">${t.is_free ? "Make PrepBank+" : "Make free"}</button>
          <button class="btn small danger" data-action="admin-delete-test" data-id="${t.id}">Delete</button>
        </div>
      </div>`).join("");
    const cq = a.classQuery.trim().toLowerCase();
    const shownClasses = a.classes.filter((c) => !cq || `${c.name} ${c.subject}`.toLowerCase().includes(cq));
    const classRows = shownClasses.map((c) => `
      <div class="admin-class-row">
        <div><span class="acr-name">${esc(c.name)}</span> <span class="meta">${esc(c.subject)}</span></div>
        <div class="acr-right">${levelTag(c.level)}<button class="btn small danger" data-action="admin-delete-class" data-id="${c.id}">Delete</button></div>
      </div>`).join("");
    const stat = (label, n) => `<div class="stat"><span class="stat-num num">${n}</span><span class="stat-label">${label}</span></div>`;

    return `
      <div class="page-head">
        <div class="eyebrow">Admin</div>
        <h1>Manage PrepBank</h1>
      </div>
      <div class="stats">
        ${stat("Practice tests", a.tests.length)}
        ${stat("Official", officialCount)}
        ${stat("Student-made", a.tests.length - officialCount)}
        ${stat("Classes", a.classes.length)}
      </div>
      <div class="admin-grid">
        <section>
          <div class="section-label">All tests <span class="num">${a.tests.length}</span></div>
          <div class="card flush">${a.tests.length === 0 ? `<div class="empty-state small">${icon("book")}<p>No tests yet. Open a class and publish one, or import one below.</p></div>` : testsRows}</div>
          <div class="section-label">Import a test from Claude</div>
          <div class="card">
            <p class="help">Send your notes to Claude in chat and ask for a "PrepBank import" for a class. Paste the JSON it gives you here. Imported tests are marked Official unless the JSON says <code>"isOfficial": false</code>.</p>
            ${a.importError ? `<div class="error-box">${esc(a.importError)}</div>` : ""}
            <textarea id="admin-import-text" placeholder='{"className": "AP World History", "subject": "Social Studies", "title": "...", "isFree": false, "mc": [...], "short": [...], "flashcards": [...]}'>${esc(a.importText)}</textarea>
            <div class="builder-actions"><button class="btn primary" data-action="admin-import" ${a.importBusy ? "disabled" : ""}>${a.importBusy ? '<span class="spinner"></span> Importing' : "Import to PrepBank"}</button></div>
          </div>
        </section>
        <section>
          <div class="section-label">Classes <span class="num">${a.classes.length}</span></div>
          <div class="card">
            <form id="admin-class-form" class="admin-class-form">
              <input type="text" name="name" id="new-class-name" placeholder="New class, e.g. AP Art History" required />
              <select name="subject" id="new-class-subject">${DEPARTMENTS.filter((d) => d !== "All").map((d) => `<option>${esc(d)}</option>`).join("")}</select>
              <select name="level" id="new-class-level"><option>On-Level</option><option>Honors</option><option>AP</option><option>Dual Credit</option><option>Elective</option></select>
              <button class="btn primary" type="submit">Add class</button>
            </form>
            <p class="help">Only admins can add classes. Students search this list and add study material to it.</p>
          </div>
          <label class="searchbox compact" for="admin-class-search">${icon("search")}<input type="text" id="admin-class-search" placeholder="Filter classes" value="${esc(a.classQuery)}" /></label>
          <div class="card flush admin-class-list">${classRows || '<p class="help pad">No classes match.</p>'}</div>
        </section>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Appearance, pins, My tests, leaderboard, settings
  // ---------------------------------------------------------------------

  const ACCENTS = [
    { id: "scots", name: "Scots blue", color: "#1b3fa6" },
    { id: "crimson", name: "Crimson", color: "#b42335" },
    { id: "emerald", name: "Emerald", color: "#157a52" },
    { id: "violet", name: "Violet", color: "#6b3fc4" },
    { id: "teal", name: "Teal", color: "#0e7c86" },
    { id: "gold", name: "Gold", color: "#a86c00" },
  ];

  function applyAppearance(p) {
    const root = document.documentElement;
    const theme = (p && p.theme) || "system";
    const accent = (p && p.accent) || "scots";
    if (theme === "system") delete root.dataset.theme; else root.dataset.theme = theme;
    root.dataset.accent = accent;
    try { localStorage.setItem("pb-appearance", JSON.stringify({ theme, accent })); } catch (e) { /* storage unavailable */ }
  }
  try { applyAppearance(JSON.parse(localStorage.getItem("pb-appearance") || "null")); } catch (e) { /* ignore */ }

  function avatarHtml(p, size) {
    const s = size || 30;
    const name = (p && p.display_name) || "?";
    if (p && p.avatar_url) return `<img class="avatar img" src="${esc(p.avatar_url)}" alt="" width="${s}" height="${s}" style="width:${s}px;height:${s}px" />`;
    return `<span class="avatar" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.38)}px">${esc(initials(name))}</span>`;
  }

  function unitLabel(u) {
    return u === null || u === undefined || u < 0 ? "Other" : "Unit " + u;
  }

  function isFilterError(e) {
    return /PB_FILTER/.test((e && (e.message || e)) || "");
  }

  // ---- Pins ----
  async function loadPins() {
    const { data } = await sb.from("pins")
      .select("id, class_id, test_id, tests(id, title, class_id, unit, is_official, is_free, question_count, flashcards, created_by)")
      .order("created_at", { ascending: false });
    state.pins = data || [];
    render();
  }
  function isPinned(kind, id) {
    return state.pins.some((p) => (kind === "class" ? p.class_id : p.test_id) === id);
  }
  async function togglePin(kind, id) {
    const col = kind === "class" ? "class_id" : "test_id";
    const existing = state.pins.find((p) => p[col] === id);
    if (existing) {
      state.pins = state.pins.filter((p) => p !== existing);
      render();
      await sb.from("pins").delete().eq("id", existing.id);
      setToast(kind === "class" ? "Class unpinned." : "Test unpinned.");
    } else {
      const { data, error } = await sb.from("pins").insert({ [col]: id })
        .select("id, class_id, test_id, tests(id, title, class_id, unit, is_official, is_free, question_count, flashcards, created_by)").single();
      if (error) { setToast("Couldn't pin that. Try again."); return; }
      state.pins.unshift(data);
      setToast(kind === "class" ? "Pinned to the top of Classes." : "Test pinned to the top of Classes.");
    }
  }
  function pinButton(kind, id, compact) {
    const on = isPinned(kind, id);
    return `<button class="pin-btn ${on ? "on" : ""} ${compact ? "compact" : ""}" data-action="toggle-pin" data-kind="${kind}" data-id="${id}" aria-pressed="${on}" title="${on ? "Unpin" : "Pin"}">${icon("pin")}${compact ? "" : `<span>${on ? "Pinned" : "Pin"}</span>`}</button>`;
  }

  async function openTestById(testId, classId) {
    const cls = state.classes.find((c) => c.id === classId);
    if (!cls) return;
    await openClass(cls);
    const t = state.tests.find((x) => x.id === testId);
    if (t) { state.currentTest = t; state.view = "test"; render(); }
    else setToast("That test isn't available anymore.");
  }

  function pinnedSection() {
    if (!state.pins.length) return "";
    const classes = state.pins.filter((p) => p.class_id).map((p) => state.classes.find((c) => c.id === p.class_id)).filter(Boolean);
    const tests = state.pins.filter((p) => p.test_id && p.tests).map((p) => p.tests);
    return `<section class="pinned">
      <div class="section-label">${icon("pin")}Pinned</div>
      <div class="popular-grid">
        ${classes.map((c) => `<button class="popular-card pinned-card" data-action="open-class" data-id="${c.id}">
          <span class="pc-dept">${esc(c.subject)}</span><span class="pc-name">${esc(c.name)}</span>
          <span class="pc-count">${(state.classCounts[c.id] || {}).test_count || 0} practice tests</span></button>`).join("")}
        ${tests.map((t) => {
          const c = state.classes.find((x) => x.id === t.class_id);
          return `<button class="popular-card pinned-card test" data-action="open-pinned-test" data-id="${t.id}" data-class="${t.class_id}">
            <span class="pc-dept">${esc(c ? c.name : "")} &middot; ${esc(unitLabel(t.unit))}</span><span class="pc-name">${esc(t.title)}</span>
            <span class="pc-count">${t.is_official ? "Official" : "Student-made"} &middot; ${t.question_count} questions</span></button>`;
        }).join("")}
      </div>
    </section>`;
  }

  // ---- My tests ----
  async function loadMyTests() {
    state.mine = { loaded: false, tests: [], stats: {}, me: null };
    render();
    const uid = state.profile.id;
    const [{ data: tests }, { data: stats }, { data: me }] = await Promise.all([
      sb.from("tests").select("*, classes(name, subject)").eq("created_by", uid).order("created_at", { ascending: false }),
      sb.rpc("my_test_stats"),
      sb.rpc("my_stats"),
    ]);
    state.mine = {
      loaded: true,
      tests: tests || [],
      stats: Object.fromEntries((stats || []).map((s) => [s.test_id, s])),
      me: (me && me[0]) || { points: 0, plays: 0, tests_published: 0, rank: null },
    };
    render();
  }

  function statTiles(me) {
    const tile = (label, n, sub) => `<div class="stat"><span class="stat-num num">${n}</span><span class="stat-label">${label}</span>${sub ? `<span class="help">${sub}</span>` : ""}</div>`;
    return `<div class="stats">
      ${tile("Points", me.points || 0)}
      ${tile("Leaderboard rank", me.rank ? "#" + me.rank : "&ndash;")}
      ${tile("Tests published", me.tests_published || 0)}
      ${tile("Times played by others", me.plays || 0)}
    </div>`;
  }

  function myTestsView() {
    const m = state.mine;
    if (!m || !m.loaded) return skeletonRows();
    const rows = m.tests.map((t) => {
      const s = m.stats[t.id] || { players: 0, plays: 0, points: 0 };
      return `<div class="admin-test ${t.is_official ? "official" : "student"}">
        <div class="at-main">
          <div class="test-badges">${t.is_official ? `<span class="badge-official">${icon("check")}Official</span>` : '<span class="badge-student">Student-made</span>'} ${t.is_free ? '<span class="badge-free">Free</span>' : `<span class="badge-plus">${icon("lock")}PrepBank+</span>`}</div>
          <div class="tr-title">${esc(t.title)}</div>
          <div class="meta">${esc(t.classes ? t.classes.name : "")} &middot; ${esc(unitLabel(t.unit))} &middot; <span class="num">${t.question_count}</span> questions</div>
          ${t.is_official ? "" : `<div class="play-line"><span><span class="num">${s.players}</span> ${s.players == 1 ? "student" : "students"}</span><span><span class="num">${s.plays}</span> ${s.plays == 1 ? "play" : "plays"}</span><span class="pts"><span class="num">+${s.points}</span> ${s.points == 1 ? "point" : "points"}</span></div>`}
        </div>
        <div class="at-actions">
          <button class="btn small" data-action="open-pinned-test" data-id="${t.id}" data-class="${t.class_id}">Open</button>
          ${t.is_official ? "" : `<button class="btn small danger" data-action="delete-my-test" data-id="${t.id}">Delete</button>`}
        </div>
      </div>`;
    }).join("");
    return `
      <div class="page-head">
        <div class="eyebrow">Your contributions</div>
        <h1>My tests</h1>
        <p class="sub">Tests you've shared with your classes. You earn points every time other students practice them.</p>
      </div>
      ${statTiles(m.me)}
      <div class="section-label">Published <span class="num">${m.tests.length}</span></div>
      ${m.tests.length ? `<div class="card flush">${rows}</div>` : `<div class="empty-state">${icon("upload")}<h3>You haven't shared a test yet</h3><p>Open one of your classes and add your study guide. When classmates practice it, you'll start earning points.</p><button class="btn primary" data-action="nav-browse">Find your class</button></div>`}
    `;
  }

  // ---- Leaderboard ----
  async function loadLeaderboard() {
    state.board = { loaded: false, rows: [], me: null };
    render();
    const [{ data: rows }, { data: me }] = await Promise.all([sb.rpc("leaderboard", { max_rows: 50 }), sb.rpc("my_stats")]);
    state.board = { loaded: true, rows: rows || [], me: (me && me[0]) || null };
    render();
  }

  function leaderboardView() {
    const b = state.board;
    if (!b || !b.loaded) return skeletonRows();
    const uid = state.profile && state.profile.id;
    const medal = (r) => (r === 1 ? "gold" : r === 2 ? "silver" : r === 3 ? "bronze" : "");
    const rows = b.rows.map((r) => `
      <div class="lb-row ${r.user_id === uid ? "me" : ""}">
        <span class="lb-rank ${medal(Number(r.rank))}">${r.rank}</span>
        ${avatarHtml(r, 36)}
        <span class="lb-name"><span class="lb-top"><span class="lb-dn">${esc(r.display_name)}</span>${r.user_id === uid ? '<span class="you">You</span>' : ""}</span><span class="meta"><span class="num">${r.tests_published}</span> ${r.tests_published == 1 ? "test" : "tests"} &middot; <span class="num">${r.plays}</span> ${r.plays == 1 ? "play" : "plays"}</span></span>
        <span class="lb-points"><span class="num">${r.points}</span> pts</span>
      </div>`).join("");
    return `
      <div class="page-head">
        <div class="eyebrow">Highland Park High School</div>
        <h1>Leaderboard</h1>
        <p class="sub">Students whose tests help the most classmates. You get 10 points each time a new student practices one of your tests, plus 1 point for each repeat (up to 4 per student). Official PrepBank tests don't count.</p>
      </div>
      ${b.me ? `<div class="card me-card">${avatarHtml(state.profile, 44)}<div><strong>${b.me.rank ? "You're #" + b.me.rank : "You're not ranked yet"}</strong><div class="help">${b.me.rank ? `<span class="num">${b.me.points}</span> points from <span class="num">${b.me.plays}</span> plays` : "Share a test in one of your classes to get on the board."}</div></div><button class="btn small" data-action="nav-mytests">My tests</button></div>` : ""}
      ${b.rows.length ? `<div class="card flush lb">${rows}</div>` : `<div class="empty-state">${icon("trophy")}<h3>No one's on the board yet</h3><p>Be the first: share a study guide in one of your classes.</p></div>`}
    `;
  }

  // ---- Settings ----
  function settingsView() {
    const p = state.profile || {};
    const s = state.settingsUi || {};
    const theme = p.theme || "system";
    const accent = p.accent || "scots";
    const plan = isAdmin() ? `<p><strong>Admin account.</strong> Every test is unlocked for you.</p>`
      : isSubscribed() ? `<p><span class="badge-plus">${icon("spark")}PrepBank+</span> Every test in every class is unlocked.</p>
          ${state.subscription.current_period_end ? `<p class="help">Renews on ${new Date(state.subscription.current_period_end).toLocaleDateString()}. $3.00 per month.</p>` : ""}
          <button class="btn" data-action="manage-billing" ${state.subscribeBusy ? "disabled" : ""}>${state.subscribeBusy ? '<span class="spinner"></span> Opening' : "Manage billing or cancel"}</button>`
      : `<p><strong>Free plan.</strong> You can take every free test and share your own.</p>
          <p class="help">PrepBank+ unlocks every test in every class for $3 a month. Cancel anytime.</p>
          <button class="btn gold" data-action="start-checkout" ${state.subscribeBusy ? "disabled" : ""}>${state.subscribeBusy ? '<span class="spinner"></span> Opening checkout' : "Get PrepBank+"}</button>`;
    return `
      <div class="page-head"><div class="eyebrow">Your account</div><h1>Settings</h1></div>
      <div class="settings">
        <section class="card settings-card">
          <h2>Profile</h2>
          <div class="avatar-row">
            ${avatarHtml(p, 72)}
            <div class="avatar-actions">
              <label class="btn small" for="avatar-input">${icon("upload")}${s.avatarBusy ? "Uploading&hellip;" : "Upload photo"}</label>
              <input type="file" id="avatar-input" accept="image/png,image/jpeg,image/webp" hidden />
              ${p.avatar_url ? `<button class="btn small ghost" data-action="remove-avatar">Remove</button>` : ""}
              <p class="help">PNG, JPG or WebP. It's cropped to a square. Keep it school-appropriate.</p>
            </div>
          </div>
          <form id="name-form" class="inline-form">
            <div class="field"><label for="settings-name">Display name</label>
              <input type="text" id="settings-name" name="name" maxlength="40" value="${esc(p.display_name || "")}" required /></div>
            <button class="btn primary" type="submit">Save name</button>
          </form>
          ${s.nameError ? `<div class="error-box">${esc(s.nameError)}</div>` : ""}
        </section>
        <section class="card settings-card">
          <h2>Appearance</h2>
          <div class="field"><label>Theme</label>
            <div class="seg">
              ${["system", "light", "dark"].map((t) => `<button class="${theme === t ? "on" : ""}" data-action="set-theme" data-theme="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
            </div>
            <p class="help">System follows your device's light or dark mode.</p>
          </div>
          <div class="field"><label>Accent color</label>
            <div class="swatches">
              ${ACCENTS.map((a) => `<button class="swatch ${accent === a.id ? "on" : ""}" data-action="set-accent" data-accent="${a.id}" style="--sw:${a.color}" aria-pressed="${accent === a.id}"><span></span>${a.name}</button>`).join("")}
            </div>
          </div>
        </section>
        <section class="card settings-card">
          <h2>Billing</h2>
          ${plan}
        </section>
        <section class="card settings-card">
          <h2>Account</h2>
          <p class="help">Signed in as <strong>${esc(state.session.user.email)}</strong></p>
          <button class="btn danger" data-action="signout">${icon("logout")}Sign out</button>
        </section>
      </div>
    `;
  }

  async function updateProfile(fields) {
    const { data, error } = await sb.from("profiles").update(fields).eq("id", state.profile.id).select("*").single();
    if (error) throw error;
    state.profile = { ...state.profile, ...data };
    return data;
  }

  async function saveDisplayName(name) {
    state.settingsUi = { ...(state.settingsUi || {}), nameError: null };
    const clean = name.trim();
    if (!clean) { state.settingsUi.nameError = "Enter a name."; render(); return; }
    try {
      await updateProfile({ display_name: clean });
      setToast("Name saved.");
    } catch (e) {
      state.settingsUi.nameError = isFilterError(e) ? "That name isn't allowed on PrepBank. Please choose another." : "Couldn't save your name. Try again.";
      render();
    }
  }

  async function setAppearance(fields) {
    const before = { theme: state.profile.theme, accent: state.profile.accent };
    state.profile = { ...state.profile, ...fields };
    applyAppearance(state.profile);
    render();
    try { await updateProfile(fields); } catch (e) {
      state.profile = { ...state.profile, ...before };
      applyAppearance(state.profile); render();
      setToast("Couldn't save that setting.");
    }
  }

  // Crop to a centered square, shrink to 256px and re-encode (also strips photo metadata)
  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const size = 256, side = Math.min(img.width, img.height);
        const canvas = document.createElement("canvas");
        canvas.width = size; canvas.height = size;
        canvas.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process that image."))), "image/jpeg", 0.86);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image we can read.")); };
      img.src = url;
    });
  }

  function avatarPath(url) {
    const m = String(url || "").match(/\/avatars\/(.+)$/);
    return m ? decodeURIComponent(m[1].split("?")[0]) : null;
  }

  async function uploadAvatar(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setToast("Upload a PNG, JPG or WebP image."); return; }
    if (file.size > 10 * 1024 * 1024) { setToast("That image is too large (10 MB max)."); return; }
    state.settingsUi = { ...(state.settingsUi || {}), avatarBusy: true };
    render();
    try {
      const blob = await resizeImage(file);
      const path = `${state.profile.id}/avatar-${Date.now()}.jpg`;
      const { error } = await sb.storage.from("avatars").upload(path, blob, { contentType: "image/jpeg", upsert: true });
      if (error) throw error;
      const { data } = sb.storage.from("avatars").getPublicUrl(path);
      const old = avatarPath(state.profile.avatar_url);
      await updateProfile({ avatar_url: data.publicUrl });
      if (old) sb.storage.from("avatars").remove([old]);
      setToast("Profile picture updated.");
    } catch (e) {
      setToast(e.message || "Upload failed.");
    }
    state.settingsUi.avatarBusy = false;
    render();
  }

  async function removeAvatar() {
    const old = avatarPath(state.profile.avatar_url);
    try {
      await updateProfile({ avatar_url: null });
      if (old) await sb.storage.from("avatars").remove([old]);
      setToast("Profile picture removed.");
    } catch (e) { setToast("Couldn't remove it. Try again."); }
    render();
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
    if (materialEl) materialEl.addEventListener("input", (e) => {
      state.builder.material = e.target.value;
      const cc = document.getElementById("char-count");
      if (cc) cc.textContent = e.target.value.length.toLocaleString() + " characters";
    });
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
      document.getElementById("dept-rail").innerHTML = deptRail();
      const extras = document.getElementById("browse-extras");
      if (extras) extras.innerHTML = browseExtras();
    });
    const adminSearch = document.getElementById("admin-class-search");
    if (adminSearch) adminSearch.addEventListener("input", (e) => {
      state.admin.classQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = document.getElementById("admin-class-search");
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    });
    const unitEl = document.getElementById("unit-select");
    if (unitEl) unitEl.addEventListener("change", (e) => { state.builder.unit = e.target.value; });
    const avatarEl = document.getElementById("avatar-input");
    if (avatarEl) avatarEl.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadAvatar(f); });
    document.querySelectorAll("select[data-unit-for]").forEach((sel) => sel.addEventListener("change", async (e) => {
      const id = e.target.dataset.unitFor, unit = e.target.value === "" ? null : Number(e.target.value);
      const { error } = await sb.from("tests").update({ unit }).eq("id", id);
      if (error) { setToast("Couldn't change the unit."); return; }
      const t = state.admin.tests.find((x) => x.id === id); if (t) t.unit = unit;
      setToast("Moved to " + unitLabel(unit) + ".");
    }));
    const officialEl = document.getElementById("opt-official");
    if (officialEl) officialEl.addEventListener("change", (e) => { state.builder.official = e.target.checked; });
  }

  document.addEventListener("submit", (e) => {
    if (e.target.id === "auth-form") { e.preventDefault(); handleAuthSubmit(e.target); }
    if (e.target.id === "name-form") { e.preventDefault(); saveDisplayName(e.target.name.value); }
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

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches('[role="button"][data-action]')) { e.preventDefault(); e.target.click(); return; }
    if (state.view === "flashcards" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      const act = { " ": "flip-card", ArrowRight: "flash-next", ArrowLeft: "flash-prev" }[e.key];
      if (act) { e.preventDefault(); const b = document.querySelector(`[data-action="${act}"]`); if (b) b.click(); return; }
    }
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      const el = document.getElementById("class-search");
      if (el) { e.preventDefault(); el.focus(); }
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
      case "filter-level": state.classLevel = el.dataset.level; render(); break;
      case "filter-unit": state.classUnit = el.dataset.unit; render(); break;
      case "toggle-pin": e.stopPropagation(); togglePin(el.dataset.kind, el.dataset.id); break;
      case "open-pinned-test": openTestById(el.dataset.id, el.dataset.class); break;
      case "nav-mytests": state.view = "mytests"; loadMyTests(); break;
      case "nav-leaderboard": state.view = "leaderboard"; loadLeaderboard(); break;
      case "nav-settings": state.view = "settings"; state.settingsUi = {}; render(); break;
      case "set-theme": setAppearance({ theme: el.dataset.theme }); break;
      case "set-accent": setAppearance({ accent: el.dataset.accent }); break;
      case "remove-avatar": removeAvatar(); break;
      case "delete-my-test": {
        if (!confirm("Delete this test? Classmates won't be able to practice it anymore, and its points go away.")) break;
        sb.from("tests").delete().eq("id", el.dataset.id).then(({ error }) => {
          if (error) { setToast("Couldn't delete that test."); return; }
          setToast("Test deleted."); loadMyTests(); loadClasses();
        });
        break;
      }
      case "clear-filters": state.classQuery = ""; state.classDept = "All"; state.classLevel = "All levels"; render(); break;
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
      case "flip-card": state.flash.flipped = !state.flash.flipped; el.classList.toggle("flipped", state.flash.flipped); el.classList.remove("fc-enter"); break;
      case "retry-quiz": startQuiz(state.quiz.test, state.quiz.mode); break;
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
