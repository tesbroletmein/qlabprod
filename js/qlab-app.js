/* =========================================================
   qlab-app.js — 프로토타입 화면을 실제 데이터에 연결하는 층
   index.html 의 인라인 스크립트 뒤에서 실행되며,
   목업 동작을 하던 전역 함수만 골라 실제 동작으로 교체합니다.
   화면(HTML/CSS)은 그대로 두고 데이터만 바꾸는 방식이라 되돌리기도 쉽습니다.
   ========================================================= */
(function () {
  "use strict";

  const A = window.QLab;

  // 프로토타입의 예시 데이터를 모두 비운다. 이제부터 모든 값은 서버에서 온다.
  MOCK.sessions = [];
  MOCK.dataBySession = {};
  MOCK.teacher = { code: "", apiKey: "", apiKeyMasked: "", hasKey: false };
  MOCK.student = { number: "", nickname: "", approved: false };

  let SELF = null;          // 로그인한 학생의 students 행
  let ROLE = null;          // 'student' | 'teacher'
  let channel = null;       // 실시간 구독
  let essayTimer = null;

  const blank = () => ({
    words: [], materials: [], students: [], shared: [],
    // 이탈 경고는 기본값이 꺼짐입니다. 선생님이 켠 세션에서만 작동합니다.
    essayTopic: "",
    rounds: [],
  });
  const bucket = (id) => (MOCK.dataBySession[id] ||= blank());

  function say(e) {
    const msg = (e && e.message) ? e.message : "요청을 처리하지 못했습니다.";
    toast(msg);
    console.error(e);
  }
  async function run(fn) { try { await fn(); } catch (e) { say(e); } }

  /* =======================================================
     1. 데이터 불러오기
     ======================================================= */
  async function hydrateStudent() {
    SELF = await A.students.me();
    if (!SELF) throw new Error("학생 정보를 찾지 못했습니다. 다시 입장해주세요.");
    MOCK.student = {
      number: SELF.student_number,
      nickname: SELF.nickname,
      approved: SELF.status === "approved",
    };
    MOCK.sessions = await A.sessions.listMine();
    state.sSessionId = SELF.session_id;
    const s = MOCK.sessions.find((x) => x.id === state.sSessionId);
    const d = bucket(state.sSessionId);
    if (s) d.essayTopic = s.essayTopic || "";
    d.students = [{
      id: SELF.id, number: SELF.student_number, nickname: SELF.nickname,
      status: SELF.status, progress: SELF.progress, updated: "", feedback: SELF.feedback,
    }];
  }

  // 서버에서 받은 한 줄 -> 화면이 쓰는 '차시 보관함' 모양으로 바꿉니다.
  function draftToSnapshot(row, sid) {
    const o = inqBlank();
    o.step1Type = row.step1_type || "";
    o.step1 = row.step1 || "";
    o.step2By = { reflective: "", debate: "", problem: "", ...(row.step2_by || {}) };
    o.step4By = { reflective: "", debate: "", problem: "", ...(row.step4_by || {}) };
    o.extraQs = Array.isArray(row.extra_questions) ? row.extra_questions : [];
    o.submitted = !!row.submitted;
    if ((row.ai_items || []).length) {
      o.step3 = {
        topic: MOCK.sessions.find((x) => x.id === sid)?.topic || "",
        question: "",
        phase: "done",
        acked: Object.values(o.step4By).some((v) => v && v.trim()),
        result: {
          items: row.ai_items || [],
        },
      };
    }
    return o;
  }
  function essayRowToSnapshot(row) {
    const o = essayBlank();
    o.steps = Array.isArray(row.steps) && row.steps.length === 5 ? row.steps : ["", "", "", "", ""];
    o.text = row.body || "";
    o.submitted = !!row.submitted;
    return o;
  }

  async function hydrateStudentData() {
    const sid = state.sSessionId;
    const d = bucket(sid);
    const [cloud, mats, feed, drafts, essays, threads, rounds] = await Promise.all([
      A.words.cloud(sid),
      A.materials.list(sid),
      A.inquiry.feed(sid),
      A.inquiry.myDrafts(SELF.id),
      A.essay.mineAll(SELF.id),
      A.discussion.loadAll(SELF.id),
      A.rounds.list(sid),
    ]);
    d.words = cloud;
    d.materials = mats;
    d.shared = feed;
    d.rounds = rounds;

    // [지난 수업] : 같은 수업 묶음에 속한 지난 세션 (없으면 빈 목록)
    state.pastSessions = await A.sessions.past();
    state.pastOpenId = null;

    // 차시별로 받아 온 것을 보관함에 넣고, 첫 차시를 화면에 올립니다.
    state.inqRounds = {}; state.essayRounds = {};
    (drafts || []).forEach((row) => {
      if (row.round_id) state.inqRounds[row.round_id] = draftToSnapshot(row, sid);
    });
    (essays || []).forEach((row) => {
      if (row.round_id) state.essayRounds[row.round_id] = essayRowToSnapshot(row);
    });
    const first = d.rounds[0].id;
    state.inqRoundId = first;
    state.essayRoundId = first;
    applyInq(state.inqRounds[first] || inqBlank());
    applyEssay(state.essayRounds[first] || essayBlank());
    // 이탈 기록은 차시와 상관없이 학생 단위로 모읍니다.
    const anyEssay = (essays || [])[0];
    state.essayLeaveTotal = anyEssay ? (anyEssay.leave_count || 0) : 0;
    state.essayLeaveLog = anyEssay && Array.isArray(anyEssay.leave_log) ? anyEssay.leave_log : [];
    const draft = null, es = null;
    state.materialsState = mats.length ? "loaded" : "empty";
    state.sharedState = feed.length ? "loaded" : "empty";

    Object.keys(threads).forEach((k) => {
      if (k.startsWith("stance:")) state.discussionStance[Number(k.slice(7))] = threads[k];
      else state.discussionThreads[Number(k)] = threads[k];
    });

    subscribe(sid);
  }

  async function hydrateTeacher() {
    MOCK.sessions = await A.sessions.listMine();
    try { state.courses = await A.courses.list(); }
    catch (e) { console.warn(e); state.courses = []; }
    if (!MOCK.sessions.length) { state.tSessionId = null; return; }
    if (!state.tSessionId || !MOCK.sessions.some((s) => s.id === state.tSessionId)) {
      state.tSessionId = MOCK.sessions[0].id;
    }
    await hydrateTeacherData();
  }

  // 학생마다 '차시별 글쓰기 제출 여부' 를 채웁니다. ([학생 모니터링] 의 차시별 보기용)
  async function fillRoundEssays(sid, d) {
    let rows = [];
    try { rows = await A.essay.sessionRows(sid); } catch (e) { console.warn(e); return; }
    const byStudent = {};
    rows.forEach((r) => {
      (byStudent[r.student_id] ||= {})[r.round_id] = {
        essaySubmitted: !!r.submitted,
        essayPreview: (r.body || "").slice(0, 60),
        essaySteps: Array.isArray(r.steps) ? r.steps : [],
      };
    });
    (d.students || []).forEach((s) => { s.byRound = byStudent[s.id] || {}; });
  }

  async function hydrateTeacherData() {
    const sid = state.tSessionId;
    if (!sid) return;
    const d = bucket(sid);
    const meta = MOCK.sessions.find((s) => s.id === sid);
    if (meta) {
      d.essayTopic = meta.essayTopic || "";
    }
    const [w, mats, studs, feed, tps, rds] = await Promise.all([
      A.words.log(sid), A.materials.list(sid),
      A.students.listForTeacher(sid), A.inquiry.feed(sid), A.topics.list(sid),
      A.rounds.list(sid),
    ]);
    d.words = w; d.materials = mats; d.students = studs; d.shared = feed;
    d.exploreTopics = tps.explore || []; d.discussTopics = tps.discuss || [];
    d.rounds = rds;
    await fillRoundEssays(sid, d);
    try { state.lockouts = await A.students.lockouts(sid); } catch (e) { state.lockouts = []; }
    subscribe(sid);
  }

  /* ---------- 실시간 갱신 ---------- */
  function subscribe(sessionId) {
    if (channel) { A.sb.removeChannel(channel); channel = null; }
    channel = A.sb.channel(`session-${sessionId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "words", filter: `session_id=eq.${sessionId}` },
        () => {
          const onQuestionTab = (ROLE === "teacher" && state.teacherTab === "p1") ||
            (ROLE === "student" && state.studentTab === "p1");
          if (onQuestionTab) run(refreshWords);
        })
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${sessionId}` },
        (payload) => {
          // 모든 차시가 함께 쓰는 공통 글쓰기 주제
          bucket(sessionId).essayTopic = payload.new.essay_topic || "";
          render();
        })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "session_rounds", filter: `session_id=eq.${sessionId}` },
        (payload) => {
          // 선생님이 차시 설정을 바꾸면 학생 화면에도 바로 반영합니다.
          const d = bucket(sessionId);
          const row = payload.new || payload.old;
          if (!row) return;
          const list = roundsOf(d);
          const idx = list.findIndex((x) => x.id === row.id);

          if (payload.eventType === "DELETE") {
            if (idx >= 0) list.splice(idx, 1);
            render();
            return;
          }
          const next = {
            id: row.id, label: row.label, note: row.note || "",
            essayTopic: row.essay_topic || "",
            questionTypes: Array.isArray(row.question_types) ? row.question_types : [],
            essayOpen: row.essay_open === true,
          };
          const wasOpen = idx >= 0 ? list[idx].essayOpen === true : false;
          if (idx >= 0) list[idx] = next; else list.push(next);

          if (ROLE === "student" && next.essayOpen !== wasOpen) {
            if (next.essayOpen) {
              // 열리는 순간 서버의 글이 지워지므로, 화면에 남은 글도 함께 비웁니다.
              delete state.essayRounds[next.id];
              if (state.essayRoundId === next.id) applyEssay(essayBlank());
              toast(`선생님이 ${next.label} 글쓰기를 열었어요.`);
            } else if (state.studentTab === "p6" && state.essayRoundId === next.id) {
              toast(`선생님이 ${next.label} 글쓰기를 닫았어요.`);
            }
          }
          render();
        })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "shared_questions", filter: `session_id=eq.${sessionId}` },
        () => {
          const onFeed = (ROLE === "student" &&
              ((state.studentTab === "p3" && state.p3Tab === "share") || state.studentTab === "p5")) ||
            (ROLE === "teacher" && state.teacherTab === "p3");
          if (onFeed) run(refreshShared);
        })
      .subscribe();
  }

  async function refreshWords() {
    const sid = ROLE === "teacher" ? state.tSessionId : state.sSessionId;
    const d = bucket(sid);
    d.words = ROLE === "teacher" ? await A.words.log(sid) : await A.words.cloud(sid);
    render();
  }
  async function refreshMaterials() {
    const sid = ROLE === "teacher" ? state.tSessionId : state.sSessionId;
    const d = bucket(sid);
    d.materials = await A.materials.list(sid);
    state.materialsState = d.materials.length ? "loaded" : "empty";
    render();
  }
  async function refreshShared() {
    const sid = ROLE === "teacher" ? state.tSessionId : state.sSessionId;
    const d = bucket(sid);
    d.shared = await A.inquiry.feed(sid);
    state.sharedState = d.shared.length ? "loaded" : "empty";
    render();
  }
  async function refreshTopics() {
    const sid = ROLE === "teacher" ? state.tSessionId : state.sSessionId;
    const d = bucket(sid);
    const tps = await A.topics.list(sid);
    d.exploreTopics = tps.explore || [];
    d.discussTopics = tps.discuss || [];
    render();
  }
  async function refreshStudents() {
    const sid = state.tSessionId;
    const d = bucket(sid);
    d.students = await A.students.listForTeacher(sid);
    await fillRoundEssays(sid, d);   // 차시별 제출 여부도 함께 채웁니다
    render();
  }

  /* =======================================================
     2. 로그인 / 로그아웃
     ======================================================= */
  const _go = window.go;
  window.go = function (route) {
    if (route === "landing" && ROLE) {
      A.auth.signOut();
      if (channel) { A.sb.removeChannel(channel); channel = null; }
      ROLE = null; SELF = null;
      resetLocalState();
    }
    _go(route);
  };

  function resetLocalState() {
    state.step = { 1: "", 2: "", 4: "" };
    state.p3Tab = "make";
    state.step3 = { topic: "", question: "", phase: "idle", result: null, acked: false };
    state.discussionThreads = {}; state.discussionStance = {}; state.discussionTopicId = null;
    state.essayText = ""; state.essaySteps = ["", "", "", "", ""];
    state.essayLastGen = ["", "", "", "", ""]; state.essaySubmitted = false;
    state.essayLeaveTotal = 0; state.essayLeaveLog = []; state.essayEngaged = false;
    state.sSessionId = null; state.tSessionId = null;
    state.isAdmin = false; state.teacherCodes = [];
    state.courses = []; state.pastSessions = []; state.pastOpenId = null;
    MOCK.dataBySession = {};
  }

  // 초기화된 비밀번호로 들어온 학생이 새 비밀번호를 정한 뒤 다시 입장할 때 쓴다.
  let pendingLogin = null;

  function afterStudentAuth(out, creds) {
    if (out && out.mustChangePin) {
      pendingLogin = creds;
      MOCK.student = { number: creds.number, nickname: creds.nickname, approved: false };
      toast(out.message || "새 비밀번호를 정해주세요.");
      _go("student-newpin");
      return Promise.resolve();
    }
    ROLE = "student";
    return bootStudent();
  }

  window.submitStudentLogin = function () {
    const num = normSno($("#f-number").value);
    const nick = $("#f-nickname").value.trim();
    const pw = $("#f-pw").value.trim();
    const code = $("#f-code").value.trim().toUpperCase();
    let ok = true;
    [["#f-number", !snoProblem(num)], ["#f-nickname", !nickProblem(nick)],
     ["#f-pw", /^[0-9]{6}$/.test(pw)], ["#f-code", code.length > 0]]
      .forEach(([sel, valid]) => { $(sel).classList.toggle("err", !valid); if (!valid) ok = false; });
    if (!ok) { toast("입력값을 다시 확인해주세요."); return; }

    const btn = document.querySelector(".main .btn-primary");
    if (btn) { btn.disabled = true; btn.textContent = "입장하는 중…"; }

    run(async () => {
      try {
        const creds = { number: num, nickname: nick, pin: pw, code };
        const out = await A.auth.studentLogin(creds);
        await afterStudentAuth(out, creds);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "입장하기"; }
      }
    });
  };

  window.submitStudentSignup = function () {
    const num = normSno($("#sg-number").value);
    const nick = ($("#sg-nickname").value || "").trim();
    const pw = ($("#sg-pw").value || "").trim();
    const pw2 = ($("#sg-pw2").value || "").trim();
    const code = ($("#sg-code").value || "").trim().toUpperCase();
    const sp = snoProblem(num);
    if (sp) { $("#sg-number").classList.add("err"); toast(sp); return; }
    const np = nickProblem(nick);
    if (np) { $("#sg-nickname").classList.add("err"); toast(np); return; }
    const p = pinProblem(pw, num);
    if (p) { $("#sg-pw").classList.add("err"); toast(p); return; }
    if (pw !== pw2) { toast("비밀번호가 서로 달라요. 다시 확인해주세요."); return; }
    if (!code) { toast("세션 코드를 입력해주세요."); return; }

    const btn = document.querySelector(".main .btn-primary");
    if (btn) { btn.disabled = true; btn.textContent = "가입하는 중…"; }
    run(async () => {
      try {
        const creds = { number: num, nickname: nick, pin: pw, code };
        const out = await A.auth.studentSignup(creds);
        toast("가입했어요. 선생님 승인을 기다려주세요.");
        await afterStudentAuth(out, creds);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "가입하기"; }
      }
    });
  };

  window.submitNewPin = function () {
    const pw = ($("#np-pw").value || "").trim();
    const pw2 = ($("#np-pw2").value || "").trim();
    const num = (MOCK.student && MOCK.student.number) || "";
    const p = pinProblem(pw, num);
    if (p) { $("#np-pw").classList.add("err"); toast(p); return; }
    if (pw !== pw2) { toast("비밀번호가 서로 달라요. 다시 확인해주세요."); return; }
    run(async () => {
      await A.auth.studentSetPin(pw);
      toast("새 비밀번호를 저장했어요.");
      // 새 비밀번호로 다시 입장해서 이 세션의 수강 기록을 만든다.
      if (pendingLogin) {
        const creds = { ...pendingLogin, pin: pw };
        pendingLogin = null;
        const out = await A.auth.studentLogin(creds);
        await afterStudentAuth(out, creds);
      } else {
        ROLE = "student";
        await bootStudent();
      }
    });
  };

  async function bootStudent() {
    ROLE = "student";
    await hydrateStudent();
    if (MOCK.student.approved) {
      await hydrateStudentData();
      _go("student-app");
    } else {
      _go("student-pending");
      watchApproval();
    }
  }

  // 승인되면 자동으로 화면이 넘어간다.
  let approvalChannel = null;
  function watchApproval() {
    if (approvalChannel) A.sb.removeChannel(approvalChannel);
    approvalChannel = A.sb.channel(`me-${SELF.id}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "students", filter: `id=eq.${SELF.id}` },
        (payload) => {
          if (payload.new.status === "approved") {
            A.sb.removeChannel(approvalChannel); approvalChannel = null;
            run(async () => {
              await hydrateStudent();
              await hydrateStudentData();
              toast("선생님이 승인했어요!");
              _go("student-app");
            });
          }
        })
      .subscribe();
  }

  ROUTES["student-pending"] = function () {
    return `
    <div class="shell"><div class="content-col">
    <div class="topbar"><div class="tb-title">승인 대기 중</div></div>
    <div class="main no-nav" style="max-width:420px;">
      <div class="state-block">
        <div class="state-icon">${Icon.clock}</div>
        <div class="state-title">선생님 승인을 기다리고 있어요</div>
        <div class="state-desc">별명 "${esc(MOCK.student.nickname)}"으로 입장을 요청했어요.
          선생님이 승인하면 자동으로 활동이 시작돼요.</div>
        <span class="badge badge-pending">${Icon.clock} 승인 대기</span>
        <div style="margin-top:24px; width:100%;">
          <button class="btn btn-outline btn-block" onclick="QLabApp.refreshApproval()">승인 상태 새로고침</button>
          <button class="btn btn-text btn-block" style="margin-top:8px;" onclick="go('landing')">나가기</button>
        </div>
      </div>
    </div>
    </div></div>`;
  };

  window.demoApproveMe = function () { QLabApp.refreshApproval(); };

  /* 교사 화면(로그인·비밀번호 정하기)은 index.html 의 코드 기반 화면을 그대로 쓴다.
     이메일은 어디에서도 입력받지 않는다. 아래에서 동작만 연결한다. */

  /* =======================================================
     3. 학생 화면 동작
     ======================================================= */
  window.setStudentTab = function (k) {
    const prev = state.studentTab;
    // [질문 공유] 는 [질문 만들기] 안의 '친구들 질문' 으로 합쳐졌습니다.
    if (k === "p4") { state.p3Tab = "share"; k = "p3"; }
    else if (k === "p3") { state.p3Tab = "make"; }
    if (k === "p6") state.essayEngaged = true;   // 글쓰기를 한 번 열면 그 뒤로는 이탈을 셉니다
    state.studentTab = k;
    state.studentSub = null;
    render();
    noteEssayTabLeave(prev, k);                  // [글쓰기] -> 다른 탭 이동도 이탈로 기록
    if (k === "p1") run(refreshWords);
    if (k === "p2" || k === "p7") { state.materialsState = "loading"; render(); run(refreshMaterials); }
    if (k === "p3" && state.p3Tab === "share") { state.sharedState = "loading"; render(); run(refreshShared); }
    if (k === "p5") { run(refreshShared).then(() => scrollChatBottom()); }
  };

  // [질문 만들기] 안의 하위 탭 전환 — '친구들 질문' 을 열 때 실제 목록을 새로 받아옵니다.
  window.setP3Tab = function (k) {
    state.p3Tab = k;
    if (k === "share") {
      state.sharedState = "loading";
      render();
      run(refreshShared);
    } else {
      render();
    }
  };

  window.addQuestion = function () {
    const el = $("#question-input");
    const v = tidyQuestion(el.value);
    if (!v) { toast("질문을 입력해주세요."); return; }
    if (v.length > QUESTION_MAX) { toast(`질문은 ${QUESTION_MAX}자 이내로 적어주세요.`); return; }
    run(async () => {
      await A.words.add(state.sSessionId, SELF.id, v);
      el.value = "";
      await refreshWords();
      toast("질문이 추가됐어요.");
    });
  };

  /* ---------- 학생 자료 올리기 ---------- */
  const _onMyImagePick = window.onMyImagePick;
  window.onMyImagePick = function (input) {
    const f = input.files && input.files[0];
    if (f) state.myUploadFile = f;
    _onMyImagePick(input);
  };
  window.clearMyImage = function () {
    state.myUploadImage = null; state.myUploadImageName = ""; state.myUploadFile = null; render();
  };

  window.addMyMaterial = function () {
    const title = (state.myUploadTitle || "").trim();
    if (!title) { toast("제목을 입력해주세요."); return; }
    const t = state.myUploadType;
    if (t === "video" && !(state.myUploadLink || "").trim()) { toast("영상 링크를 입력해주세요."); return; }
    if (t === "image" && !state.myUploadFile) { toast("이미지 파일을 선택해주세요."); return; }
    if (t === "video" && !/^https?:\/\//i.test(state.myUploadLink.trim())) {
      toast("http 또는 https 로 시작하는 주소를 넣어주세요."); return;
    }
    run(async () => {
      let path = null;
      if (t === "image") path = await A.storage.upload(state.sSessionId, String(SELF.id), state.myUploadFile);
      await A.materials.addStudent(state.sSessionId, SELF.id, {
        type: t, title, desc: (state.myUploadDesc || "").trim(),
        link: t === "video" ? state.myUploadLink.trim() : null, storagePath: path,
        exploreTopicId: state.myUploadExploreId || null,
        discussQuestionId: state.myUploadDiscussId || null,
      });
      state.myUploadTitle = ""; state.myUploadDesc = ""; state.myUploadLink = "";
      state.myUploadImage = null; state.myUploadImageName = ""; state.myUploadFile = null;
      state.myUploadExploreId = ""; state.myUploadDiscussId = "";
      await refreshMaterials();
      toast("자료를 올렸어요.");
    });
  };

  window.confirmDeleteMyMaterial = function (id) {
    const m = sData().materials.find((x) => x.id === id);
    run(async () => {
      await A.materials.remove(id, m?.storagePath);
      closeModal();
      await refreshMaterials();
      toast("삭제했어요.");
    });
  };

  window.submitAnswers = function (id) {
    const m = sData().materials.find((x) => x.id === id);
    const draft = state.answerDraft["m" + id] || [];
    // 선생님이 정한 최소 글자 수를 채우지 못하면 제출되지 않습니다.
    const short = shortAnswers(m, draft);
    if (short.length) {
      toast(`Q${short[0].i + 1} 답변을 ${short[0].min}자 이상 적어주세요. (지금 ${short[0].len}자)`);
      refreshAnswerUI(id);
      return;
    }
    if (!draft.some((a) => a && a.trim())) { toast("답변을 한 개 이상 작성해주세요."); return; }
    run(async () => {
      await A.materials.saveAnswers(SELF.id, m.questionIds, draft, m.questionMins);
      await refreshMaterials();
      toast("답변을 제출했어요.");
    });
  };

  /* ---------- 탐구 질문 만들기 ---------- */
  window.saveStep = function (n) {
    if (n === 1) {
      if (!state.step1Type) { toast("질문 유형을 먼저 골라주세요."); return; }
      const el = $("#step1");
      const v = (el ? el.value : state.step[1]).trim();
      if (!v) { toast("질문을 입력해주세요."); return; }
      state.step[1] = v; state.stepView = 2;
      render();
      run(async () => {
        await A.inquiry.saveDraft(state.sSessionId, SELF.id, state.inqRoundId,
          { step1: v, step1_type: state.step1Type });
        await A.students.setProgress(SELF.id, Math.max(1, SELF.progress || 0));
      });
    }
    if (n === 2) {
      const list = filledStep2();
      if (!list.length) { toast("질문을 한 개 이상 적어주세요."); return; }
      state.step3.topic = sSession().topic;
      state.step3.question = list.map((o) => `[${o.label}] ${o.text}`).join("\n");
      state.stepView = 3;
      render();
      run(async () => {
        await A.inquiry.saveDraft(state.sSessionId, SELF.id, state.inqRoundId,
          { step2_by: state.step2By });
        await A.students.setProgress(SELF.id, 2);
      });
    }
  };

  window.runAIEval = function () {
    state.stepView = 3;
    state.step3.phase = "loading";
    render();
    const list = filledStep2().map((o) => ({ label: o.label, text: o.text }));
    A.inquiry.evaluate(state.step3.question, list, state.inqRoundId)
      .then((r) => {
        state.step3.phase = "done";
        state.step3.result = {
          items: r.items || [],           // 질문마다 따로 받은 피드백
        };
        render();
        A.students.setProgress(SELF.id, 3);
      })
      .catch((e) => { state.step3.phase = "error"; render(); toast(e.message); });
  };

  // STEP 5 '질문 더하기' 목록도 서버에 함께 저장합니다.
  window.addExtraQ = function () {
    const el = $("#extra-q");
    const v = (el ? el.value : "").trim().replace(/\s+/g, " ");
    if (!v) { toast("질문을 입력해주세요."); return; }
    if (v.length > QUESTION_MAX) { toast(`질문은 ${QUESTION_MAX}자 이내로 적어주세요.`); return; }
    if ((state.extraQs || []).some((x) => x === v)) { toast("이미 더한 질문이에요."); return; }
    if ((state.extraQs || []).length >= 10) { toast("질문은 10개까지 더할 수 있어요."); return; }
    state.extraQs = (state.extraQs || []).concat([v]);
    render();
    const el2 = $("#extra-q"); if (el2) el2.focus();
    run(async () => {
      await A.inquiry.saveDraft(state.sSessionId, SELF.id, state.inqRoundId,
        { extra_questions: state.extraQs });
    });
  };
  window.removeExtraQ = function (i) {
    state.extraQs = (state.extraQs || []).filter((_, idx) => idx !== i);
    render();
    run(async () => {
      await A.inquiry.saveDraft(state.sSessionId, SELF.id, state.inqRoundId,
        { extra_questions: state.extraQs });
    });
  };

  window.finalizeQuestions = function () {
    const list = filledStep4();
    const extras = state.extraQs || [];
    if (!list.length) { toast("STEP 4의 최종 질문을 한 개 이상 입력해주세요."); goStep(4); return; }
    const rid = state.inqRoundId;
    const label = roundLabel(sData(), rid);
    run(async () => {
      await A.inquiry.saveDraft(state.sSessionId, SELF.id, rid, {
        step4_by: state.step4By,
        extra_questions: extras,
        submitted: true,
      });
      // 이미 공유한 질문이 있으면 새로 만들지 않고 고칩니다.
      //   (그대로 다시 넣으면 예전 질문이 그대로 남아 두 번 올라갑니다)
      const r = await A.inquiry.syncShare(state.sSessionId, SELF.id, rid, list, extras);
      await A.students.setProgress(SELF.id, 4);
      state.step[4] = list[0].text;
      state.inqSubmitted = true;
      saveInqRound();
      await refreshShared();
      const total = list.length + extras.length;
      let msg = `${label} 질문 ${total}개를 공유했어요.`;
      if (r.updated) msg += ` (${r.updated}개 고침)`;
      if (r.kept) msg += ` 선생님이 승인한 질문 ${r.kept}개는 그대로 두었어요.`;
      toast(msg);
      setStudentTab("p4");
    });
  };
  window.reopenInqRound = function () {
    state.inqSubmitted = false;
    state.stepView = 5;
    render(); window.scrollTo(0, 0);
    run(async () => {
      await A.inquiry.saveDraft(state.sSessionId, SELF.id, state.inqRoundId, { submitted: false });
    });
    toast("다시 열었어요. 고친 뒤 한 번 더 공유하면 올렸던 질문이 고쳐집니다.");
  };

  /* ---------- 차시 전환 (서버 저장까지) ---------- */
  window.switchInqRound = function (rid) {
    if (rid === state.inqRoundId) return;
    saveInqRound();
    applyInq(state.inqRounds[rid] || inqBlank());
    state.inqRoundId = rid;
    render(); window.scrollTo(0, 0);
  };
  window.switchEssayRound = function (rid) {
    if (rid === state.essayRoundId) return;
    saveEssayRound();
    applyEssay(state.essayRounds[rid] || essayBlank());
    state.essayRoundId = rid;
    render(); window.scrollTo(0, 0);
  };

  /* ---------- 질문 공유 ---------- */
  window.toggleReaction = function (id, flagKey, countKey) {
    const kind = countKey === "curious" ? "curious" : "like";
    run(async () => {
      const r = await A.inquiry.toggleReaction(id, kind);
      const q = sData().shared.find((x) => x.id === id);
      if (q) { q[flagKey] = r.on; q[countKey] = Number(r.count); }
      render();
    });
  };

  window.addComment = function (id) {
    const v = $("#new-comment").value.trim();
    if (!v) { toast("댓글을 입력해주세요."); return; }
    run(async () => {
      await A.inquiry.comment(id, SELF.id, v);
      closeModal();
      await refreshShared();
      toast("댓글이 등록됐어요.");
    });
  };

  /* ---------- AI 토론 ---------- */
  window.selectDiscussionTopic = function (id) {
    state.discussionTopicId = id;
    render();
    run(async () => {
      const t = await A.discussion.load(SELF.id, id);
      state.discussionThreads[id] = t.messages;
      if (t.stance) state.discussionStance[id] = t.stance;
      render();
      scrollChatBottom();
    });
  };

  function sendToAI({ stance, message }) {
    const id = state.discussionTopicId;
    state.discussionPhase = "loading";
    render();
    scrollChatBottom();
    A.discussion.send({ questionId: id, stance, message })
      .then((out) => {
        state.discussionPhase = "idle";
        state.discussionStance[id] = out.stance;
        state.discussionThreads[id] = out.messages;
        render();
        scrollChatBottom();
      })
      .catch((e) => { state.discussionPhase = "error"; render(); toast(e.message); });
  }

  window.startDiscussion = function (stance) { sendToAI({ stance }); };
  window.changeStance = function (stance) {
    if (state.discussionStance[state.discussionTopicId] === stance) return;
    sendToAI({ stance });
  };
  window.sendDiscussion = function () {
    const el = $("#chat-input");
    const v = el.value.trim();
    if (!v) return;
    el.value = "";
    sendToAI({ message: v });
  };
  window.retryDiscussion = function () { state.discussionPhase = "idle"; render(); };

  /* ---------- 글쓰기 ---------- */
  function scheduleEssaySave() {
    if (!essayOpen()) return;          // 선생님이 열기 전에는 저장하지 않습니다
    clearTimeout(essayTimer);
    essayTimer = setTimeout(() => {
      A.essay.save(state.sSessionId, SELF.id, state.essayRoundId, {
        steps: state.essaySteps, body: state.essayText,
      }).catch((e) => console.warn(e));
    }, 1200);
  }
  const _onEssayInput = window.onEssayInput;
  window.onEssayInput = function (el) { _onEssayInput(el); scheduleEssaySave(); };
  const _onEssayStepInput = window.onEssayStepInput;
  window.onEssayStepInput = function (i, el) { _onEssayStepInput(i, el); scheduleEssaySave(); };

  window.submitEssay = function () {
    if (!essayOpen()) { toast("선생님이 글쓰기를 열어야 제출할 수 있어요."); return; }
    const v = $("#essay-text").value.trim();
    if (v.length < 10) { toast("조금 더 자세하게 작성해주세요."); return; }
    run(async () => {
      state.essayText = v;
      await A.essay.save(state.sSessionId, SELF.id, state.essayRoundId, {
        steps: state.essaySteps, body: v, submitted: true,
      });
      state.essaySubmitted = true;
      saveEssayRound();
      render();
      toast(`${roundLabel(sData(), state.essayRoundId)} 글쓰기를 제출했어요.`);
    });
  };

  // 이탈 기록 저장.
  //   보내려는 순간이 곧 화면을 벗어나는 순간이라, 모바일에서는 OS 가 통신을
  //   끊어 버리는 일이 있습니다. 그래서 보내기 전에 '아직 못 보냈다' 고 표시해 두고,
  //   화면으로 돌아왔을 때(handleReturnEvent) 다시 한 번 보냅니다.
  let leavePending = null;

  function flushLeave() {
    if (!leavePending || !SELF) return;
    const payload = leavePending;
    A.essay.save(payload.sid, SELF.id, payload.rid, payload.patch)
      .then(() => { if (leavePending === payload) leavePending = null; })
      .catch((e) => console.warn(e));   // 실패하면 표시를 남겨 두고 다음에 다시 보냅니다
  }

  const _handleLeaveEvent = window.handleLeaveEvent;
  window.handleLeaveEvent = function (reason) {
    const before = state.essayLeaveTotal;
    _handleLeaveEvent(reason);
    if (state.essayLeaveTotal !== before && SELF) {
      leavePending = {
        sid: state.sSessionId, rid: state.essayRoundId,
        patch: {
          leave_count: state.essayLeaveTotal, leave_log: state.essayLeaveLog,
          steps: state.essaySteps, body: state.essayText,
        },
      };
      flushLeave();
    }
  };

  // 화면으로 돌아왔을 때 못 보낸 기록을 다시 보냅니다.
  window.onEssayReturn = flushLeave;

  // 페이지가 완전히 사라지기 직전에도 한 번 더 시도합니다.
  window.addEventListener("pagehide", flushLeave);

  /* =======================================================
     4. 교사 화면 동작
     ======================================================= */
  window.setTeacherTab = function (k) {
    state.teacherTab = k;
    render();
    if (k === "p1") run(refreshWords);
    if (k === "p2") run(refreshMaterials);
    if (k === "p3") run(async () => { await refreshShared(); await refreshStudents(); });
    if (k === "p3") run(refreshLockouts);
    if (k === "p4" || k === "p5") run(refreshStudents);
    if (k === "settings") run(async () => { await loadKeyStatus(); await loadTeacherCodes(); render(); });
  };

  /* ---------- 차시 관리 (교사) ---------- */
  window.addRound = function () {
    const list = roundsOf(tData());
    if (list.length >= 12) { toast("차시는 12개까지 만들 수 있어요."); return; }
    const n = list.length + 1;
    run(async () => {
      const id = await A.rounds.create(state.tSessionId, n, n + "차시");
      list.push({ id, label: n + "차시", note: "", essayTopic: "" });
      render();
      toast(`${n}차시를 추가했어요.`);
    });
  };
  window.saveRound = function (id) {
    const r = roundById(roundsOf(tData()), id);
    if (!r) return;
    const label = ($("#rd-label").value || "").trim();
    if (!label) { toast("차시 이름을 입력해주세요."); return; }
    const note = ($("#rd-note").value || "").trim();
    const essayTopic = ($("#rd-topic").value || "").trim();
    run(async () => {
      await A.rounds.update(id, { label, note, essayTopic });
      r.label = label; r.note = note; r.essayTopic = essayTopic;
      closeModal(); render(); toast("차시 설정을 저장했어요.");
    });
  };
  window.confirmDeleteRound = function (id) {
    const d = tData();
    run(async () => {
      await A.rounds.remove(id);
      d.rounds = roundsOf(d).filter((r) => r.id !== id);
      closeModal(); render(); toast("차시를 지웠어요.");
    });
  };

  window.uploadMaterial = function () {
    const title = (state.uploadTitle || "").trim();
    if (!title) { toast("제목을 입력해주세요."); return; }
    const questions = normalizedUploadQuestions();   // [{ prompt, min }]
    run(async () => {
      let path = null;
      if (state.uploadType === "image" && state.uploadFile) {
        path = await A.storage.upload(state.tSessionId, "teacher", state.uploadFile);
      }
      await A.materials.addTeacher(state.tSessionId, {
        type: state.uploadType, title, desc: (state.uploadDesc || "").trim(),
        link: state.uploadLink || null, storagePath: path, questions,
      });
      state.uploadQuestions = [{ prompt: "", min: 0 }];
      state.uploadTitle = ""; state.uploadDesc = "";
      state.uploadType = "video"; state.uploadFile = null; state.uploadFileName = "";
      state.materialTab = "teacher";
      await refreshMaterials();
      toast(questions.length ? `자료와 질문 ${questions.length}개를 등록했어요.` : "자료를 등록했어요.");
    });
  };

  window.deleteMaterial = function (id) {
    const m = tData().materials.find((x) => x.id === id);
    run(async () => {
      await A.materials.remove(id, m?.storagePath);
      await refreshMaterials();
      toast("자료를 삭제했어요.");
    });
  };

  // 차시별 글쓰기 주제
  window.saveEssayTopic = function () {
    const r = tRound();
    if (!r) return;
    const v = $("#essay-topic-input").value.trim();
    run(async () => {
      await A.rounds.update(r.id, { essayTopic: v });
      r.essayTopic = v;
      render();
      toast(`${r.label} 글쓰기 주제를 저장했어요.`);
    });
  };
  // 모든 차시가 함께 쓰는 공통 주제
  window.saveCommonEssayTopic = function () {
    const v = $("#essay-topic-common").value.trim();
    run(async () => {
      await A.sessions.setEssayTopic(state.tSessionId, v);
      const meta = MOCK.sessions.find((s) => s.id === state.tSessionId);
      if (meta) meta.essayTopic = v;
      tData().essayTopic = v;
      render();
      toast("공통 글쓰기 주제를 저장했어요.");
    });
  };

  // 질문 만들기 유형은 차시마다 따로 정합니다.
  window.toggleQuestionType = function (k) {
    const d = tData();
    const r = tRound();
    if (!r) return;
    const cur = activeStep2Types(d, r).map((t) => t.k);
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    if (!next.length) { toast("질문 유형은 최소 한 가지를 골라야 해요."); return; }
    const ordered = STEP2_TYPES.map((t) => t.k).filter((x) => next.includes(x));
    run(async () => {
      await A.rounds.update(r.id, { questionTypes: ordered });
      r.questionTypes = ordered;
      render();
      toast(`${r.label} 질문 유형을 저장했어요.`);
    });
  };

  window.applyEssayDetect = function (on) {
    const sid = state.tSessionId;
    const r = tRound();
    if (!r) return;
    run(async () => {
      // 켤 때는 '이 차시' 에 써 둔 글만 먼저 지웁니다. 다른 차시는 그대로예요.
      let cleared = 0;
      if (on) cleared = await A.essay.clearSession(sid, r.id);
      await A.rounds.update(r.id, { essayOpen: on });
      r.essayOpen = on;
      await refreshStudents();
      render();
      toast(on
        ? (cleared > 0
            ? `${r.label} 글쓰기를 열었어요. 이 차시에 쓴 글 ${cleared}건을 지웠어요.`
            : `${r.label} 글쓰기를 열었어요.`)
        : `${r.label} 글쓰기를 닫았어요. 학생은 이 차시의 글을 쓸 수 없어요.`);
    });
  };

  // 승인을 바꾸면 주제 목록도 다시 받아옵니다(승인이 풀리면 주제에서 자동으로 빠지므로).
  function reopenDetail() {
    if (state.detailTarget) renderStudentDetail(state.detailTarget);
  }
  window.toggleApproveExplore = function (id) {
    const q = tData().shared.find((x) => x.id === id);
    const next = !q.approvedForExplore;
    run(async () => {
      await A.inquiry.setApproved(id, "explore", next);
      await refreshShared();
      await refreshTopics();
      reopenDetail();
      toast(next ? "탐구용으로 승인했어요." : "탐구용 승인을 취소했어요.");
    });
  };
  window.toggleApproveDiscussion = function (id) {
    const q = tData().shared.find((x) => x.id === id);
    const next = !q.approvedForDiscussion;
    run(async () => {
      await A.inquiry.setApproved(id, "discuss", next);
      await refreshShared();
      await refreshTopics();
      reopenDetail();
      toast(next ? "토론용으로 승인했어요." : "토론용 승인을 취소했어요.");
    });
  };

  /* ---------- 주제(탐구하기 / AI 토론하기) ---------- */
  window.confirmAddTopic = function (kind) {
    const v = ($("#topic-title").value || "").trim();
    if (!v) { toast("주제 이름을 입력해주세요."); return; }
    if (topicList(kind).length >= 6) { toast("주제는 최대 6개까지 만들 수 있어요."); return; }
    run(async () => {
      await A.topics.add(state.tSessionId, kind, v, topicList(kind).length);
      await refreshTopics();
      closeModal();
      toast("주제를 추가했어요.");
    });
  };
  window.confirmRenameTopic = function (kind, tid) {
    const v = ($("#topic-title").value || "").trim();
    if (!v) { toast("주제 이름을 입력해주세요."); return; }
    run(async () => {
      await A.topics.rename(tid, v);
      await refreshTopics();
      closeModal();
      toast("주제 이름을 바꿨어요.");
    });
  };
  window.confirmRemoveTopic = function (kind, tid) {
    run(async () => {
      await A.topics.remove(tid);
      await refreshTopics();
      closeModal();
      toast("주제를 삭제했어요.");
    });
  };
  window.toggleAssignQuestion = function (kind, tid, qid) {
    const t = topicList(kind).find((x) => x.id === tid);
    if (!t) return;
    const on = !(t.questionIds || []).includes(qid);
    run(async () => {
      await A.topics.setQuestion(tid, qid, on);
      await refreshTopics();
      openAssignQuestions(kind, tid);   // 시트를 열어 둔 채로 갱신
    });
  };
  window.unassignQuestion = function (kind, tid, qid) {
    run(async () => {
      await A.topics.setQuestion(tid, qid, false);
      await refreshTopics();
      toast("주제에서 뺐어요.");
    });
  };

  window.saveFeedback = function (id) {
    const v = $("#fb-text").value.trim();
    run(async () => {
      await A.students.setFeedback(id, v);
      closeModal();
      await refreshStudents();
      toast("피드백을 저장했어요.");
    });
  };
  window.approveStudent = function (id) {
    run(async () => {
      await A.students.setStatus(id, "approved");
      closeModal(); await refreshStudents(); toast("학생을 승인했어요.");
    });
  };
  window.rejectStudent = function (id) {
    run(async () => {
      await A.students.setStatus(id, "rejected");
      closeModal(); await refreshStudents(); toast("학생 요청을 반려했어요.");
    });
  };
  window.saveStudentEdit = function (id) {
    const v = $("#edit-nick").value.trim();
    const p = nickProblem(v);                    // 한글 6글자 이내
    if (p) { $("#edit-nick").classList.add("err"); toast(p); return; }
    run(async () => {
      await A.students.setNickname(id, v);
      closeModal(); await refreshStudents(); toast("수정 내용을 반영했어요.");
    });
  };
  window.confirmDeleteStudent = function (id) {
    run(async () => {
      await A.students.remove(id);
      closeModal(); await refreshStudents(); toast("삭제했어요.");
    });
  };

  async function refreshLockouts() {
    if (ROLE !== "teacher" || !state.tSessionId) return;
    try { state.lockouts = await A.students.lockouts(state.tSessionId); }
    catch (e) { state.lockouts = []; }
    render();
  }

  window.unlockStudent = function (number) {
    run(async () => {
      await A.students.unlock(state.tSessionId, number);
      await refreshLockouts();
      toast("잠금을 풀었어요. 다시 로그인할 수 있어요.");
    });
  };

  window.resetPw = function (id) {
    openCenterModal(`
      <div class="sheet-title">비밀번호 초기화</div>
      <p class="t-caption" style="margin:8px 0 12px;">학생이 다시 입장할 때 쓸 숫자 6자리를 정해주세요.
        고유 번호와 같은 숫자, 반복·연속 숫자는 쓸 수 없어요.</p>
      <div class="field"><input class="input" id="new-pin" maxlength="6" inputmode="numeric" placeholder="예: 482913"></div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-outline btn-block" onclick="closeModal()">취소</button>
        <button class="btn btn-primary btn-block" onclick="QLabApp.confirmResetPin(${id})">변경</button>
      </div>`);
  };

  /* ---------- 생기부 초안 ---------- */
  window.collectStudentEvidence = function (s) {
    return {
      finalQuestion: s.finalQuestion || null,
      words: Array.isArray(s.words) ? s.words : [],
      materialAnswers: (s.answerCount || 0) > 0
        ? [{ title: "자료 질문 답변", count: s.answerCount }] : [],
      discussionCount: s.discussionCount || 0,
      essayStepCount: (s.essaySteps || []).filter((v) => v && v.trim()).length,
      essaySubmitted: !!s.essaySubmitted,
      essayPreview: s.essayPreview || "",
    };
  };

  window.generateRecordDraft = function (id) {
    state.recordPhase = "loading";
    renderRecordSheet();
    A.records.generate(id)
      .then((out) => {
        const s = tData().students.find((x) => x.id === id);
        if (out.insufficient) { state.recordPhase = "insufficient"; renderRecordSheet(); return; }
        s.recordDraft = out.draft;
        state.recordPhase = "done";
        renderRecordSheet();
        render();
      })
      .catch((e) => { state.recordPhase = "error"; renderRecordSheet(); toast(e.message); });
  };

  window.saveRecordDraft = function (id) {
    const v = $("#record-text").value.trim();
    run(async () => {
      await A.records.save(state.tSessionId, id, v);
      closeModal();
      await refreshStudents();
      toast("생기부 초안을 저장했어요.");
    });
  };

  /* ---------- 키 / 세션 ---------- */
  async function loadKeyStatus() {
    try {
      const st = await A.keys.status();
      MOCK.teacher.hasKey = st.hasKey || st.fallback;
      MOCK.teacher.apiKeyMasked = st.hasKey
        ? "•••• " + st.key_last4
        : (st.fallback ? "공용 키 사용 중" : "");
      render();
    } catch (e) { console.warn(e); }
  }

  window.saveApiKey = function () {
    const v = $("#new-api-key").value.trim();
    if (!v) { toast("API 키를 입력해주세요."); return; }
    run(async () => {
      const out = await A.keys.set(v);
      MOCK.teacher.hasKey = true;
      MOCK.teacher.apiKeyMasked = "•••• " + out.key_last4;
      closeModal(); render();
      toast("API 키를 저장했어요. 키는 서버에만 보관돼요.");
    });
  };

  window.createSession = function () {
    const cls = $("#ns-class").value.trim();
    const topic = $("#ns-topic").value.trim();
    if (!cls || !topic) { toast("학급명과 주제를 모두 입력해주세요."); return; }
    run(async () => {
      const created = await A.sessions.create(cls, topic);
      MOCK.sessions = await A.sessions.listMine();
      state.tSessionId = created.id;
      state.teacherTab = "p1";
      await hydrateTeacherData();
      closeModal(); render();
      toast("새 세션을 만들었어요. 세션 코드: " + created.code);
    });
  };

  window.switchSession = function (id) {
    state.tSessionId = id;
    state.teacherTab = "p1";
    run(async () => {
      await hydrateTeacherData();
      closeModal(); render();
      toast("세션을 전환했어요.");
    });
  };

  /* ---------- 내보내기 ---------- */
  function csvCell(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }
  function download(name, text) {
    const blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }
  // 내보내기는 index.html 의 exportAllCsv() 가 담당합니다.
  // (학생 활동 요약 + 브레인스토밍 질문 기록은 항상, 생기부 초안은 선택에 따라 포함)
  function exportCsv() { exportAllCsv(); }
  window.syncSheet = function () {
    const btn = $("#sync-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = `${Icon.refresh} 준비 중…`; }
    setTimeout(() => {
      exportAllCsv();
      const summary = exportSections().map((p) => `${p.label} ${p.rows.length - 1}건`).join(" · ");
      toast(`표로 내려받았어요 — ${summary}`);
      render();
    }, 300);
  };

  /* =======================================================
     5. 렌더 후 보정 (프로토타입 HTML 을 최소한만 손봄)
     ======================================================= */
  window.afterRender = function () {
    // (0) [더보기] 의 API 키 카드에 '연결 점검' 버튼을 붙인다
    const keyBtn = document.querySelector('button[onclick="openApiKeyEdit()"]');
    if (keyBtn && !keyBtn.dataset.checkWired) {
      keyBtn.dataset.checkWired = "1";
      const b = document.createElement("button");
      b.className = "btn btn-text btn-block";
      b.style.marginTop = "6px";
      b.textContent = "인공지능 연결 점검";
      b.onclick = () => window.checkAiSetup();
      keyBtn.insertAdjacentElement("afterend", b);
    }

    // (1) 교사 자료 업로드 영역에 실제 파일 선택 붙이기
    const drop = document.querySelector('#up-desc')
      ?.closest(".card")?.querySelector('div[style*="dashed"]');
    if (drop && !drop.dataset.wired) {
      drop.dataset.wired = "1";
      const isImage = state.uploadType === "image";
      drop.innerHTML = isImage
        ? `<input type="file" id="up-file" accept="image/*" style="display:none">
           <label for="up-file" style="cursor:pointer; display:block;">
             ${Icon.image}<div class="t-caption" style="margin-top:6px;">
             ${state.uploadFileName ? esc(state.uploadFileName) : "눌러서 이미지 파일 선택 (5MB 이하)"}</div></label>`
        : `<div class="t-caption">영상은 링크로, 읽기 자료는 설명으로 등록해요.
             이미지 파일이 필요하면 유형을 '이미지'로 바꿔주세요.</div>
           <input class="input" id="up-link" style="margin-top:10px;" placeholder="영상 링크(https://...)"
             value="${esc(state.uploadLink || "")}" oninput="state.uploadLink=this.value;">`;
      const fileInput = drop.querySelector("#up-file");
      if (fileInput) {
        fileInput.addEventListener("change", (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (f.size > 5 * 1024 * 1024) { toast("이미지 용량이 너무 커요. (5MB 이하)"); return; }
          state.uploadFile = f; state.uploadFileName = f.name; render();
        });
      }
    }

    // (2) 구글 시트 동기화는 현재 '표 내려받기' 로 동작하므로 문구를 맞춘다
    const sync = document.querySelector("#sync-btn");
    if (sync && !sync.disabled) sync.innerHTML = `${Icon.download} 학생 활동 표로 내려받기`;

    // (3) 예시 코드 안내문 정리
    document.querySelectorAll(".field-hint").forEach((el) => {
      if (el.textContent.includes("예시 코드")) {
        el.textContent = "코드를 모른다면 담당 선생님께 확인하세요.";
      }
    });
  };

  /* =======================================================
     교사 로그인 · 최초 비밀번호 설정 · 관리자 코드 발급
     (이메일 없이 교사 코드만 쓴다)
     ======================================================= */
  async function enterTeacher(teacher) {
    ROLE = "teacher";
    state.isAdmin = !!(teacher && teacher.isAdmin);
    MOCK.teacher.code = (teacher && teacher.code) || "";
    await hydrateTeacher();
    await loadKeyStatus();
    await loadTeacherCodes();
    _go("teacher-app");
  }

  async function loadTeacherCodes() {
    if (!state.isAdmin) { state.teacherCodes = []; return; }
    try { state.teacherCodes = await A.adminCodes.list(); }
    catch (e) { console.warn(e); state.teacherCodes = []; }
  }

  window.submitTeacherLogin = function () {
    const code = ($("#t-code").value || "").trim().toLowerCase();
    const pw = $("#t-pw").value || "";
    if (!code || !pw) { toast("교사 코드와 비밀번호를 입력해주세요."); return; }
    const btn = document.querySelector(".main .btn-primary");
    if (btn) { btn.disabled = true; btn.textContent = "입장하는 중…"; }
    run(async () => {
      try {
        const teacher = await A.auth.teacherLogin({ code, password: pw });
        await enterTeacher(teacher);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "입장하기"; }
      }
    });
  };

  window.submitTeacherSetup = function () {
    const code = ($("#ts-code").value || "").trim().toLowerCase();
    const token = ($("#ts-token").value || "").trim().toUpperCase();
    const name = ($("#ts-name").value || "").trim();
    const pw = $("#ts-pw").value || "", pw2 = $("#ts-pw2").value || "";
    if (!code || !token) { toast("교사 코드와 최초설정번호를 입력해주세요."); return; }
    if (pw.length < 8) { toast("비밀번호는 8자 이상으로 정해주세요."); return; }
    if (pw !== pw2) { toast("비밀번호가 서로 달라요. 다시 확인해주세요."); return; }
    run(async () => {
      await A.auth.teacherSetup({ code, setupToken: token, password: pw, displayName: name });
      // 설정이 끝나면 같은 코드·비밀번호로 바로 로그인한다.
      const teacher = await A.auth.teacherLogin({ code, password: pw });
      toast("비밀번호를 정했어요. 다음부터는 교사 코드와 비밀번호로 들어오세요.");
      await enterTeacher(teacher);
    });
  };

  window.issueTeacherCode = function () {
    const label = ($("#tc-label") ? $("#tc-label").value : "").trim();
    run(async () => {
      const out = await A.adminCodes.issue(label);
      await loadTeacherCodes();
      closeModal();
      showIssuedCode(out.code, out.setupToken, out.label);
    });
  };

  window.toggleRevokeCode = function (code, revoked) {
    run(async () => {
      await A.adminCodes.revoke(code, !!revoked);
      await loadTeacherCodes();
      toast(revoked ? "코드를 회수했어요." : "코드를 되살렸어요.");
      render();
    });
  };

  // [더보기 → 인공지능 연결 점검] : 키와 모델이 실제로 쓸 수 있는 상태인지 확인합니다.
  window.checkAiSetup = function () {
    toast("확인하는 중이에요…");
    run(async () => {
      const st = await A.keys.check();
      const list = st.models || [];
      openCenterModal(`
        <div class="sheet-title">인공지능 연결 점검</div>
        <div class="card" style="background:var(--c-neutral-bg); border:none; margin:10px 0 12px;">
          <div class="t-caption">등록된 키</div>
          <div class="t-body-md" style="margin-bottom:8px;">${st.hasKey ? "•••• " + esc(st.key_last4 || "") : (st.fallback ? "공용 키 사용 중" : "없음")}</div>
          <div class="t-caption">설정된 모델 이름</div>
          <div class="t-body-md" style="font-family:ui-monospace,monospace;">${esc(st.model || "-")}</div>
        </div>
        ${st.checkError
          ? `<div class="card" style="background:var(--c-warning-bg); border:none; margin-bottom:12px;">
               <div class="t-body">${esc(st.checkError)}</div></div>`
          : `<div class="t-caption" style="margin-bottom:6px;">이 키로 쓸 수 있는 모델 ${list.length}개</div>
             <div class="card" style="background:var(--c-neutral-bg); border:none; margin-bottom:12px; max-height:220px; overflow:auto;">
               ${list.length
                 ? list.map((m) => `<div class="t-caption" style="font-family:ui-monospace,monospace; ${m === st.model ? "color:var(--c-primary); font-weight:600;" : ""}">${esc(m)}</div>`).join("")
                 : `<div class="t-caption">목록을 받지 못했어요.</div>`}
             </div>`}
        <button class="btn btn-primary btn-block" onclick="closeModal()">닫기</button>`);
    });
  };

  /* =======================================================
     세션 관리 (전환 · 만들기 · 삭제) + 수업 묶음
     ======================================================= */

  // 수업 묶음별로 나눠서 보여준다. 묶이지 않은 세션은 맨 아래.
  function groupedSessions() {
    const groups = new Map();
    (MOCK.sessions || []).forEach((s) => {
      const key = s.courseId || "";
      if (!groups.has(key)) groups.set(key, { title: s.courseTitle || "", list: [] });
      groups.get(key).list.push(s);
    });
    const out = [...groups.entries()]
      .filter(([k]) => k !== "")
      .map(([, v]) => v)
      .sort((a, b) => a.title.localeCompare(b.title));
    if (groups.has("")) out.push({ title: "", list: groups.get("").list });
    return out;
  }

  window.renderSessionManagerSheet = function () {
    const groups = groupedSessions();
    const row = (s) => `
      <div class="list-item" style="${s.id === state.tSessionId ? "border-color:var(--c-primary);" : ""}">
        <div style="flex:1; min-width:0; cursor:pointer;" onclick="switchSession('${s.id}')">
          <div class="row-between">
            <span class="t-body-md">${esc(s.className)}</span>
            ${s.id === state.tSessionId
              ? `<span class="badge badge-active">${Icon.check} 사용 중</span>`
              : `<span class="badge badge-closed">전환</span>`}
          </div>
          <div class="t-caption">${esc(s.topic)} · 코드 ${esc(s.code)}</div>
        </div>
        <button class="btn btn-sm btn-danger" style="flex:0 0 auto; margin-left:8px;"
          onclick="event.stopPropagation(); askDeleteSession('${s.id}')">삭제</button>
      </div>`;

    openSheet(`
      <div class="sheet-title">세션 관리</div>
      <p class="t-caption" style="margin-bottom:12px;">지금 등록된 API 키로, 여러 학급(세션)을 나눠서 운영할 수 있어요.</p>
      ${MOCK.sessions.length ? groups.map((g) => `
        ${g.title
          ? `<div class="t-caption" style="margin:10px 0 6px; color:var(--c-primary);">${Icon.spark} ${esc(g.title)}</div>`
          : `<div class="t-caption" style="margin:10px 0 6px; color:var(--c-text-3);">묶이지 않은 세션</div>`}
        <div class="stack">${g.list.map(row).join("")}</div>`).join("")
        : `<div class="t-caption" style="color:var(--c-text-3); margin-bottom:12px;">아직 만든 세션이 없어요.</div>`}
      <button class="btn btn-secondary btn-block" style="margin-top:14px;"
        onclick="openNewSessionForm()">${Icon.spark} 새 세션 만들기</button>
    `);
  };

  window.openNewSessionForm = function () {
    const courses = state.courses || [];
    openSheet(`
      <div class="sheet-title">새 세션 만들기</div>
      <div class="field" style="margin-top:12px;"><label>학급명</label>
        <input class="input" id="ns-class" placeholder="예: 2학년 3반">
        <div class="field-hint">이미 쓴 학급명은 다시 쓸 수 없어요. (예: 2학년 3반 / 2학년3반 은 같은 이름)</div></div>
      <div class="field"><label>주제</label>
        <input class="input" id="ns-topic" placeholder="예: 지역 소멸과 청소년"></div>

      <div class="divider"></div>
      <div class="field">
        <label>수업 묶음 (선택)</label>
        <select class="input" id="ns-course" onchange="onCoursePick(this)">
          <option value="">묶지 않음 (단독 세션)</option>
          ${courses.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join("")}
          <option value="__new">+ 새 수업 묶음 만들기…</option>
        </select>
        <div class="field-hint">같은 묶음으로 두면 학생이 [지난 수업]에서 지난 시간에 한 활동을 다시 볼 수 있어요.</div>
      </div>
      <div class="field" id="ns-newcourse-wrap" style="display:none;">
        <label>새 수업 묶음 이름</label>
        <input class="input" id="ns-newcourse" placeholder="예: 2026 2학년 도덕">
      </div>

      <div style="display:flex; gap:8px; margin-top:6px;">
        <button class="btn btn-outline btn-block" onclick="renderSessionManagerSheet()">취소</button>
        <button class="btn btn-primary btn-block" onclick="createSession()">만들기</button>
      </div>`);
  };

  // 화면에서 먼저 한 번 걸러 준다. (서버에서도 다시 확인한다)
  function normName(v) { return String(v ?? "").replace(/\s+/g, "").toLowerCase(); }
  function dupClassName(name) {
    return (MOCK.sessions || []).some((s) => normName(s.className) === normName(name));
  }

  window.createSession = function () {
    const cls = $("#ns-class").value.trim();
    const topic = $("#ns-topic").value.trim();
    const pick = $("#ns-course") ? $("#ns-course").value : "";
    const newCourse = $("#ns-newcourse") ? $("#ns-newcourse").value.trim() : "";

    if (!cls || !topic) { toast("학급명과 주제를 모두 입력해주세요."); return; }
    if (dupClassName(cls)) {
      $("#ns-class").classList.add("err");
      toast(`이미 "${cls}" 학급이 있어요. 다른 학급명을 써주세요.`);
      return;
    }
    if (pick === "__new" && !newCourse) { toast("새 수업 묶음 이름을 입력해주세요."); return; }

    const course = pick === "__new" ? { courseTitle: newCourse }
      : (pick ? { courseId: pick } : null);

    run(async () => {
      const created = await A.sessions.create(cls, topic, course);
      MOCK.sessions = await A.sessions.listMine();
      state.courses = await A.courses.list();
      state.tSessionId = created.id;
      state.teacherTab = "p1";
      await hydrateTeacherData();
      closeModal(); render();
      toast("새 세션을 만들었어요. 세션 코드: " + created.code);
    });
  };

  window.switchSession = function (id) {
    state.tSessionId = id;
    state.teacherTab = "p1";
    run(async () => {
      await hydrateTeacherData();
      closeModal(); render();
      toast("세션을 전환했어요.");
    });
  };

  // 되돌릴 수 없는 작업이라, 학급명을 직접 입력해야 지워집니다.
  window.askDeleteSession = function (id) {
    const s = (MOCK.sessions || []).find((x) => x.id === id);
    if (!s) return;
    const n = ((MOCK.dataBySession[id] || {}).students || []).length;
    openCenterModal(`
      <div class="sheet-title">세션을 지울까요?</div>
      <div class="card" style="background:var(--c-warning-bg); border:none; margin:10px 0 12px;">
        <div class="t-body-md" style="margin-bottom:4px;">${esc(s.className)} · ${esc(s.topic)}</div>
        <div class="t-caption">이 세션의 학생 명단${n ? ` (${n}명)` : ""}, 질문, 자료, 글쓰기 기록이 <b>모두 사라집니다.</b>
          되돌릴 수 없어요. 학생 계정 자체는 남아 있어서 다른 세션에는 그대로 들어올 수 있어요.</div>
      </div>
      <div class="field">
        <label>확인을 위해 학급명을 그대로 입력해주세요</label>
        <input class="input" id="del-confirm" placeholder="${esc(s.className)}" autocapitalize="off">
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-outline btn-block" onclick="closeModal()">취소</button>
        <button class="btn btn-danger btn-block" onclick="confirmDeleteSession('${id}')">삭제</button>
      </div>`);
  };

  window.confirmDeleteSession = function (id) {
    const s = (MOCK.sessions || []).find((x) => x.id === id);
    if (!s) return;
    const typed = ($("#del-confirm") ? $("#del-confirm").value : "").trim();
    if (typed.replace(/\s+/g, "") !== s.className.replace(/\s+/g, "")) {
      toast("학급명이 달라요. 그대로 입력해주세요.");
      return;
    }
    run(async () => {
      await A.sessions.remove(id);
      if (channel) { A.sb.removeChannel(channel); channel = null; }
      delete MOCK.dataBySession[id];
      MOCK.sessions = await A.sessions.listMine();
      state.courses = await A.courses.list();
      if (state.tSessionId === id) {
        state.tSessionId = MOCK.sessions.length ? MOCK.sessions[0].id : null;
        state.teacherTab = "p1";
      }
      if (state.tSessionId) await hydrateTeacherData();
      closeModal(); render();
      toast(`"${s.className}" 세션을 지웠어요.`);
    });
  };

  /* =======================================================
     6. 시작
     ======================================================= */
  window.QLabApp = {
    exportCsv,
    refreshApproval() {
      run(async () => {
        await hydrateStudent();
        if (MOCK.student.approved) {
          await hydrateStudentData();
          toast("승인됐어요!");
          _go("student-app");
        } else {
          toast("아직 승인 대기 중이에요.");
        }
      });
    },
    confirmResetPin(id) {
      const pin = $("#new-pin").value.trim();
      if (!/^[0-9]{6}$/.test(pin)) { toast("숫자 6자리로 입력해주세요."); return; }
      run(async () => {
        await A.students.resetPin(id, pin);
        closeModal();
        toast("비밀번호를 바꿨어요. 학생에게 새 6자리를 알려주세요.");
      });
    },
    reload() { return ROLE === "teacher" ? hydrateTeacherData() : hydrateStudentData(); },
  };

  // 새로고침해도 로그인 상태를 이어간다.
  (async function boot() {
    try {
      const cur = await A.auth.currentUser();
      if (!cur) return;
      ROLE = cur.role;
      if (cur.role === "teacher") {
        await enterTeacher({ isAdmin: cur.isAdmin, code: "" });
      } else {
        await bootStudent();
      }
    } catch (e) {
      console.warn("자동 로그인 실패", e);
      await A.auth.signOut();
    }
  })();
})();
