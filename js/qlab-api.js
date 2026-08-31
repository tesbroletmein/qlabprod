/* =========================================================
   qlab-api.js — Supabase 접근 계층
   화면 코드(index.html)는 이 파일의 QLab.* 만 호출합니다.
   Gemini 키는 이 파일 어디에도 존재하지 않습니다. (Edge Function 이 대신 호출)
   ========================================================= */
(function () {
  "use strict";

  const CFG = window.QLAB_CONFIG || {};
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: "qlab-auth",
      // 로그인 정보를 '이 탭에만' 둡니다.
      //   탭을 닫으면 사라지므로, 주소를 복사해 새 탭·다른 사람에게 보내도
      //   그 사람은 로그인되어 있지 않습니다. 컴퓨터실 공용 PC 를 위한 설정입니다.
      //   (기존 localStorage 방식은 브라우저를 껐다 켜도 로그인이 남아 있었습니다)
      storage: window.sessionStorage,
    },
  });

  const FN = (name) => `${CFG.SUPABASE_URL}/functions/v1/${name}`;

  /* ---------- 공통 ---------- */
  function fail(error, fallback) {
    if (!error) return;
    console.error(error);
    // RLS(접근 권한) 로 막힌 경우는 학생이 알아볼 수 있는 말로 바꿔 줍니다.
    if (error.code === "42501" || /row-level security/i.test(error.message || "")) {
      const e = new Error(
        "저장 권한이 없습니다. 선생님 승인이 아직 안 되었거나, 다른 학급의 화면을 보고 있을 수 있어요. " +
        "새로고침한 뒤에도 같으면 선생님께 알려주세요.",
      );
      // 화면 코드가 '내 정보를 다시 읽고 한 번 더 해보기' 를 할 수 있도록 표시해 둡니다.
      e.denied = true;
      throw e;
    }
    throw new Error(error.message || fallback || "요청을 처리하지 못했습니다.");
  }

  async function callFunction(name, payload, { auth = true } = {}) {
    const headers = { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY };
    if (auth) {
      const { data } = await sb.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("로그인이 필요합니다.");
      headers.Authorization = `Bearer ${token}`;
    } else {
      headers.Authorization = `Bearer ${CFG.SUPABASE_ANON_KEY}`;
    }
    const res = await fetch(FN(name), { method: "POST", headers, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "요청을 처리하지 못했습니다.");
    return body;
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  function fmtDate(iso) {
    const d = new Date(iso);
    return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /* ---------- 인증 ---------- */
  const auth = {
    async currentUser() {
      const { data } = await sb.auth.getSession();
      if (!data.session) return null;
      const { data: profile } = await sb.from("profiles")
        .select("role, display_name, is_admin").eq("id", data.session.user.id).maybeSingle();
      return {
        user: data.session.user,
        role: profile?.role ?? "student",
        displayName: profile?.display_name ?? "",
        isAdmin: !!profile?.is_admin,
      };
    },

    // 학생: 개인정보 없이 고유 번호·별명·6자리 비밀번호·세션 코드로 입장
    //  서버가 { mustChangePin: true } 를 돌려주면 새 비밀번호를 먼저 정해야 한다.
    async studentLogin({ number, nickname, pin, code }) {
      const out = await callFunction("auth-gateway", {
        action: "student_login",
        student_number: number, nickname, pin, session_code: code,
      }, { auth: false });
      const { error } = await sb.auth.setSession(out.session);
      fail(error, "로그인 처리에 실패했습니다.");
      return out;
    },

    // 학생: 처음 한 번 계정 만들기 (만든 뒤 바로 로그인까지 된다)
    async studentSignup({ number, nickname, pin, code }) {
      const out = await callFunction("auth-gateway", {
        action: "student_signup",
        student_number: number, nickname, pin, session_code: code,
      }, { auth: false });
      const { error } = await sb.auth.setSession(out.session);
      fail(error, "로그인 처리에 실패했습니다.");
      return out;
    },

    // 학생: 선생님이 초기화한 뒤 스스로 새 6자리 정하기 (로그인 상태에서 호출)
    async studentSetPin(newPin) {
      return callFunction("auth-gateway", { action: "student_set_pin", new_pin: newPin });
    },

    // 교사: 발급받은 코드 + 최초설정번호로 비밀번호 정하기 (이메일을 쓰지 않는다)
    async teacherSetup({ code, setupToken, password, displayName }) {
      return callFunction("auth-gateway", {
        action: "teacher_setup",
        code, setup_token: setupToken, password, display_name: displayName,
      }, { auth: false });
    },

    // 교사: 코드 + 비밀번호로 로그인. 서버가 세션 토큰과 교사 정보를 돌려준다.
    async teacherLogin({ code, password }) {
      const out = await callFunction("auth-gateway", {
        action: "teacher_login", code, password,
      }, { auth: false });
      const { error } = await sb.auth.setSession(out.session);
      fail(error, "로그인 처리에 실패했습니다.");
      return out.teacher; // { code, displayName, isAdmin }
    },

    async signOut() { await sb.auth.signOut(); },
  };

  /* ---------- 관리자: 교사 코드 ---------- */
  const adminCodes = {
    // RLS 때문에 관리자(is_admin) 계정만 목록이 보인다.
    async list() {
      const { data, error } = await sb.from("teacher_codes")
        .select("code, label, setup_token, auth_uid, is_admin, revoked, created_at")
        .order("created_at", { ascending: false });
      fail(error);
      return (data || []).map((c) => ({
        code: c.code, label: c.label, setupToken: c.setup_token,
        claimed: !!c.auth_uid, isAdmin: c.is_admin, revoked: c.revoked,
      }));
    },
    async issue(label) {
      return callFunction("auth-gateway", { action: "issue_teacher_code", label });
    },
    async revoke(code, revoked) {
      return callFunction("auth-gateway", { action: "revoke_teacher_code", code, revoked });
    },
  };

  /* ---------- 세션 ---------- */
  const sessions = {
    async listMine() {
      const { data, error } = await sb.from("sessions")
        .select("*, course:courses(id, title)")
        // 선생님이 정한 순서대로. (position 이 없던 예전 세션은 뒤로 갑니다)
        .order("position", { ascending: true })
        .order("created_at", { ascending: false });
      fail(error);
      return (data || []).map((s) => ({
        id: s.id, className: s.class_name, topic: s.topic, code: s.code,
        status: s.status, createdAt: fmtDate(s.created_at),
        essayTopic: s.essay_topic,
        position: Number(s.position) || 0,
        autoApprove: s.auto_approve === true,
        courseId: s.course_id || null,
        courseTitle: s.course?.title || "",
      }));
    },

    // 세션 설정 바꾸기 (지금은 '가입 · 입장 자동 승인' 에 씁니다)
    async update(sessionId, patch) {
      const { error } = await sb.from("sessions").update(patch).eq("id", sessionId);
      fail(error);
    },

    // course : { courseId } 기존 묶음에 넣기 / { courseTitle } 새 묶음을 만들며 넣기
    async create(className, topic, course) {
      const { data, error } = await sb.rpc("create_session", {
        p_class_name: className,
        p_topic: topic,
        p_course_id: (course && course.courseId) || null,
        p_course_title: (course && course.courseTitle) || null,
      });
      fail(error);
      return data;
    },

    // 세션 고치기 (단원 · 주제 · 학급)
    async update(sessionId, className, topic, course) {
      const { data, error } = await sb.rpc("update_session", {
        p_session: sessionId,
        p_class_name: className,
        p_topic: topic,
        p_course_id: (course && course.courseId) || null,
        p_course_title: (course && course.courseTitle) || null,
      });
      fail(error);
      return data;
    },

    // 목록 순서 바꾸기 : 넘긴 차례대로 1, 2, 3... 이 매겨집니다.
    async reorder(ids) {
      const { error } = await sb.rpc("reorder_sessions", { p_ids: ids });
      fail(error);
    },

    // 세션 삭제 : 올린 이미지 파일을 먼저 지우고, 나머지 기록은 서버가 함께 지운다.
    async remove(sessionId) {
      try {
        const { data: files } = await sb.from("materials")
          .select("storage_path").eq("session_id", sessionId).not("storage_path", "is", null);
        const paths = (files || []).map((f) => f.storage_path).filter(Boolean);
        if (paths.length) await sb.storage.from("materials").remove(paths);
      } catch (e) {
        console.warn("이미지 정리 실패(계속 진행합니다)", e);
      }
      const { data, error } = await sb.rpc("delete_session", { p_session: sessionId });
      fail(error);
      return data;
    },

    async setEssayTopic(sessionId, topic) {
      const { error } = await sb.from("sessions").update({ essay_topic: topic }).eq("id", sessionId);
      fail(error);
    },

    // 학생: 같은 수업 묶음의 지난 세션 (내가 쓴 것만)
    async past() {
      const { data, error } = await sb.rpc("get_past_sessions");
      if (error) { console.warn(error); return []; }
      return Array.isArray(data) ? data : [];
    },
  };

  /* ---------- 수업 묶음 ---------- */
  const courses = {
    async list() {
      const { data, error } = await sb.from("courses")
        .select("id, title, created_at").order("created_at", { ascending: false });
      fail(error);
      return (data || []).map((c) => ({ id: c.id, title: c.title }));
    },
    async rename(id, title) {
      const { error } = await sb.from("courses").update({ title }).eq("id", id);
      fail(error);
    },
  };

  /* ---------- 학생 ---------- */
  const students = {
    // 내 수강 기록 한 줄.
    //   한 학생이 여러 학급에 등록될 수 있으므로, '지금 들어와 있는 학급' 의
    //   줄을 서버가 골라 줍니다. (get_my_student)
    //   창고에 09_updates.sql 을 아직 안 돌렸다면 예전 방식으로 물러납니다.
    async me() {
      const { data: s } = await sb.auth.getSession();
      if (!s.session) return null;
      const { data, error } = await sb.rpc("get_my_student");
      if (!error) return data || null;
      console.warn("get_my_student 없음 - 예전 방식으로 읽습니다.", error);
      const res = await sb.from("students")
        .select("*").eq("auth_uid", s.session.user.id)
        .order("id", { ascending: false }).limit(1);
      fail(res.error);
      return (res.data && res.data[0]) || null;
    },
    // 학급을 옮길 때 '지금 학급' 을 서버에 알려 줍니다.
    async setActiveSession(sessionId) {
      const { error } = await sb.rpc("set_active_session", { p_session: sessionId });
      if (error) console.warn("set_active_session 실패", error);
    },
    // 담임 선생님 이름. 없으면 빈 글자를 돌려줍니다.
    async teacherName(sessionId) {
      const { data, error } = await sb.rpc("session_teacher_name", { p_session: sessionId });
      if (error) { console.warn("선생님 이름을 읽지 못했습니다.", error); return ""; }
      return data || "";
    },
    async listForTeacher(sessionId) {
      const { data, error } = await sb.rpc("get_session_students", { p_session: sessionId });
      fail(error);
      return (data || []).map((s) => ({
        ...s,
        essaySteps: Array.isArray(s.essaySteps) ? s.essaySteps : [],
        essayLeaveLog: Array.isArray(s.essayLeaveLog) ? s.essayLeaveLog : [],
        essaySubmitLog: Array.isArray(s.essaySubmitLog) ? s.essaySubmitLog : [],
        essaySubmitCount: s.essaySubmitCount || 0,
        // 아직 안 냈어도 얼마나 썼는지 알 수 있게 글자 수를 함께 셉니다.
        essayChars: String(s.essayBody || "").trim().length,
        essayPreview: String(s.essayBody || "").slice(0, 60),
        words: Array.isArray(s.words) ? s.words : [],
      }));
    },
    async setStatus(id, status) {
      const { error } = await sb.from("students").update({ status }).eq("id", id);
      fail(error);
    },
    // area 'all' 이면 전체 피드백, 그 밖에는 영역별 피드백에 저장합니다.
    async setFeedback(id, feedback, area) {
      if (!area || area === "all") {
        const { error } = await sb.from("students").update({ feedback }).eq("id", id);
        fail(error);
        return;
      }
      const { error } = await sb.rpc("set_student_feedback", {
        p_student: id, p_area: area, p_text: feedback,
      });
      fail(error);
    },
    async setNickname(id, nickname) {
      const { error } = await sb.from("students").update({ nickname }).eq("id", id);
      fail(error);
    },
    async setProgress(id, progress) {
      const { error } = await sb.from("students").update({ progress }).eq("id", id);
      if (error) console.warn(error);
    },
    // 학생 지우기.
    //   수강 기록만 지우면 계정이 남아, 같은 고유 번호로 다시 가입할 수 없습니다.
    //   그래서 Edge Function 에 맡겨 계정·로그인까지 함께 정리합니다.
    async remove(id) {
      return callFunction("auth-gateway", { action: "student_delete", student_id: id });
    },

    // 수강 기록이 하나도 없는 '남은 계정' 을 찾습니다. (세어 보기만)
    async scanOrphanAccounts() {
      return callFunction("auth-gateway", { action: "orphan_accounts", mode: "scan" });
    },
    // 실제로 지웁니다. 로그인 계정까지 함께 지워야 같은 번호로 다시 가입할 수 있습니다.
    async cleanOrphanAccounts() {
      return callFunction("auth-gateway", { action: "orphan_accounts", mode: "clean" });
    },
    // 로그인이 잠긴 학생 목록 (담임 선생님만 보입니다)
    async lockouts(sessionId) {
      const { data, error } = await sb.from("login_lockouts")
        // IP 는 화면에서 쓰지 않으므로 아예 받아오지 않는다 (개인정보 최소 수집)
        .select("student_number, fail_count, locked, last_failed_at, locked_at")
        .eq("session_id", sessionId).eq("locked", true)
        .order("locked_at", { ascending: false });
      fail(error);
      return (data || []).map((r) => ({
        studentNumber: r.student_number,
        failCount: r.fail_count,
        locked: r.locked,
        lastFailedAt: fmtDateTime(r.last_failed_at),
      }));
    },
    // 잠금 풀기 (student_number 를 비우면 학급 전체)
    async unlock(sessionId, studentNumber) {
      return callFunction("auth-gateway", {
        action: "unlock_student",
        session_id: sessionId,
        student_number: studentNumber || "",
      });
    },
    async resetPin(id, pin) {
      return callFunction("auth-gateway", { action: "student_reset_pin", student_id: id, new_pin: pin });
    },
  };

  /* ---------- 브레인스토밍 질문 ----------
     테이블 이름은 예전 그대로 words 지만, 담기는 값은 '질문' 입니다.  */
  const words = {
    async cloud(sessionId) {
      const { data, error } = await sb.rpc("get_word_cloud", { p_session: sessionId });
      fail(error);
      return (data || []).map((r) => ({ t: r.word, n: Number(r.n) }));
    },
    async log(sessionId) { // 교사 전용
      const { data, error } = await sb.rpc("get_word_log", { p_session: sessionId });
      fail(error);
      const grouped = new Map();
      (data || []).forEach((r) => {
        if (!grouped.has(r.word)) grouped.set(r.word, { t: r.word, by: [] });
        grouped.get(r.word).by.push({ who: r.nickname, at: fmtDateTime(r.created_at) });
      });
      return [...grouped.values()];
    },
    async add(sessionId, studentId, word) {
      const { error } = await sb.from("words")
        .insert({ session_id: sessionId, student_id: studentId, word });
      fail(error);
    },
  };

  /* ---------- 자료 ---------- */
  // 화면의 질문 한 칸을 창고 한 줄로 바꿉니다.
  function questionRow(materialId, q, i) {
    if (typeof q === "string") {
      return { material_id: materialId, position: i, prompt: q, min_chars: 0, kind: "text" };
    }
    const choice = q.kind === "choice";
    return {
      material_id: materialId,
      position: i,
      prompt: q.prompt,
      kind: choice ? "choice" : "text",
      min_chars: choice ? 0 : Math.max(0, Math.min(2000, Number(q.min) || 0)),
      options: choice ? (q.options || []) : [],
      answer_index: choice && Number.isInteger(q.answer) && q.answer >= 0 ? q.answer : null,
    };
  }

  const materials = {
    async list(sessionId) {
      const { data, error } = await sb.from("materials")
        .select(`id, owner, type, title, description, link, storage_path, created_at,
                 explore_topic_id, discuss_question_id,
                 student:students(student_number, nickname),
                 material_questions(id, position, prompt, min_chars, kind, options, answer_index)`)
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false });
      fail(error);

      const materialIds = (data || []).map((m) => m.id);
      const questionIds = (data || []).flatMap((m) => (m.material_questions || []).map((q) => q.id));

      let answers = [];
      if (questionIds.length) {
        const res = await sb.from("material_answers")
          .select("question_id, answer, updated_at, student:students(id, student_number, nickname)")
          .in("question_id", questionIds);
        fail(res.error);
        answers = res.data || [];
      }

      const out = [];
      for (const m of (data || [])) {
        const qs = (m.material_questions || []).sort((a, b) => a.position - b.position);
        const byStudent = new Map();
        qs.forEach((q, idx) => {
          answers.filter((a) => a.question_id === q.id).forEach((a) => {
            const key = a.student?.student_number ?? "-";
            if (!byStudent.has(key)) {
              byStudent.set(key, {
                number: key,
                who: a.student?.nickname || "(미설정)",
                at: fmtDateTime(a.updated_at),
                list: new Array(qs.length).fill(""),
              });
            }
            byStudent.get(key).list[idx] = a.answer;
          });
        });

        out.push({
          id: m.id,
          type: m.type,
          owner: m.owner,
          by: m.student?.nickname || "",
          byNumber: m.student?.student_number || "",
          title: m.title,
          desc: m.description,
          link: m.link || undefined,
          src: m.storage_path ? await storage.signedUrl(m.storage_path) : undefined,
          storagePath: m.storage_path || null,
          date: fmtDate(m.created_at),
          questions: qs.map((q) => q.prompt),
          questionIds: qs.map((q) => q.id),
          questionMins: qs.map((q) => Number(q.min_chars) || 0),
          // 객관식 정보. 예전 질문에는 없으므로 서술형으로 봅니다.
          questionKinds: qs.map((q) => (q.kind === "choice" ? "choice" : "text")),
          questionOptions: qs.map((q) => (Array.isArray(q.options) ? q.options : [])),
          questionAnswers: qs.map((q) =>
            (q.answer_index === null || q.answer_index === undefined
              ? -1 : Number(q.answer_index))),
          answers: [...byStudent.values()],
          exploreTopicId: m.explore_topic_id || null,
          discussQuestionId: m.discuss_question_id || null,
        });
      }
      // 화면에서는 오래된 자료가 위로 오도록 (프로토타입과 동일한 느낌)
      return out.reverse();
    },

    // questions: [{ prompt, min, kind, options, answer }]
    //   kind 'text'   → min = 최소 글자 수 (0 이면 제한 없음)
    //   kind 'choice' → options = 보기 목록, answer = 정답 번호(없으면 null)
    async addTeacher(sessionId, { title, desc, link, storagePath, questions }) {
      const { data, error } = await sb.from("materials").insert({
        session_id: sessionId, owner: "teacher", type: "article", title,
        description: desc || "", link: link || null, storage_path: storagePath || null,
      }).select("id").single();
      fail(error);
      const list = (questions || []).map((q, i) => questionRow(data.id, q, i));
      if (list.length) fail((await sb.from("material_questions").insert(list)).error);
      return data.id;
    },

    // 자료의 제목·설명·링크 고치기
    //  storagePath 를 넘기면 첨부 이미지 경로도 함께 바꿉니다.
    //    · undefined  → 손대지 않음
    //    · 문자열     → 그 경로로 바꿈
    //    · null       → 이미지 빼기
    async update(id, { title, desc, link, storagePath }) {
      const patch = { title, description: desc || "", link: link || null };
      if (storagePath !== undefined) patch.storage_path = storagePath;
      const { error } = await sb.from("materials").update(patch).eq("id", id);
      fail(error);
    },

    // 저장소에 남은 파일 지우기.
    //   여기서 실패해도 자료는 이미 제대로 저장된 뒤이므로,
    //   오류를 위로 던지지 않고 기록만 남깁니다.
    //   (파일 하나가 남는 것보다 저장이 취소되는 쪽이 훨씬 나쁩니다)
    async discardFile(path) {
      if (!path) return;
      try {
        const { error } = await sb.storage.from("materials").remove([path]);
        if (error) console.warn("옛 이미지 파일을 지우지 못했습니다.", error);
      } catch (e) {
        console.warn("옛 이미지 파일을 지우지 못했습니다.", e);
      }
    },

    // 질문 목록 통째로 맞추기.
    //   id 가 있는 질문은 고쳐 쓰고, 없는 질문은 새로 넣고,
    //   목록에서 빠진 질문만 지웁니다.
    //   이렇게 해야 그대로 둔 질문의 학생 답변이 살아남습니다.
    async saveQuestions(materialId, questions) {
      const { data: before, error: e0 } = await sb.from("material_questions")
        .select("id").eq("material_id", materialId);
      fail(e0);
      const keep = new Set();
      const list = questions || [];

      for (let i = 0; i < list.length; i += 1) {
        const q = list[i];
        const row = questionRow(materialId, q, i);
        if (q.id) {
          keep.add(Number(q.id));
          const { error } = await sb.from("material_questions")
            .update(row).eq("id", q.id);
          fail(error);
        } else {
          const { data, error } = await sb.from("material_questions")
            .insert(row).select("id").single();
          fail(error);
          keep.add(Number(data.id));
        }
      }

      const gone = (before || []).map((r) => Number(r.id)).filter((id) => !keep.has(id));
      if (gone.length) {
        // 답변도 함께 지워집니다(창고가 알아서 정리합니다).
        fail((await sb.from("material_questions").delete().in("id", gone)).error);
      }
    },

    // exploreTopicId : 선생님이 만든 탐구 주제, discussQuestionId : 토론용으로 승인된 질문
    async addStudent(sessionId, studentId, { title, desc, link, storagePath, exploreTopicId, discussQuestionId }) {
      const { data, error } = await sb.from("materials").insert({
        session_id: sessionId, owner: "student", student_id: studentId, type: "article", title,
        description: desc || "", link: link || null, storage_path: storagePath || null,
        explore_topic_id: exploreTopicId || null,
        discuss_question_id: discussQuestionId || null,
      }).select("id").single();
      fail(error);
      return data.id;
    },

    async remove(id, storagePath) {
      if (storagePath) await sb.storage.from("materials").remove([storagePath]);
      const { error } = await sb.from("materials").delete().eq("id", id);
      fail(error);
    },

    // mins 를 넘기면 최소 글자 수를 서버로 보내기 전에 한 번 더 확인합니다.
    //   kinds 를 넘기면 객관식은 글자 수 검사를 건너뜁니다.
    async saveAnswers(studentId, questionIds, list, mins, kinds) {
      const isChoice = (i) => (kinds || [])[i] === "choice";
      const need = (mins || []).findIndex(
        (m, i) => !isChoice(i) && Number(m) > 0 && (list[i] || "").trim().length < Number(m));
      if (need > -1) {
        throw new Error(`Q${need + 1} 답변을 ${mins[need]}자 이상 적어주세요.`);
      }
      const rows = questionIds
        .map((qid, i) => ({ question_id: qid, student_id: studentId, answer: list[i] || "" }))
        .filter((r) => r.answer.trim().length > 0);
      if (!rows.length) return;
      const { error } = await sb.from("material_answers")
        .upsert(rows, { onConflict: "question_id,student_id" });
      fail(error);
    },
  };

  /* ---------- 파일 저장소 ---------- */
  /* =========================================================
     topics : 탐구하기 주제 / AI 토론하기 주제 (kind = 'explore' | 'discuss')
     한 질문을 여러 주제에 중복해서 넣을 수 있습니다.
  ========================================================= */
  const topics = {
    async list(sessionId) {
      const { data, error } = await sb.from("topics")
        .select("id, kind, title, position, topic_questions(question_id)")
        .eq("session_id", sessionId)
        .order("kind", { ascending: true })
        .order("position", { ascending: true })
        .order("id", { ascending: true });
      fail(error);
      const out = { explore: [], discuss: [] };
      (data || []).forEach((t) => {
        (out[t.kind] || (out[t.kind] = [])).push({
          id: t.id,
          title: t.title,
          questionIds: (t.topic_questions || []).map((r) => r.question_id),
        });
      });
      return out;
    },
    async add(sessionId, kind, title, position) {
      const { data, error } = await sb.from("topics")
        .insert({ session_id: sessionId, kind, title, position: position || 0 })
        .select("id").single();
      fail(error);
      return data.id;
    },
    async rename(topicId, title) {
      fail((await sb.from("topics").update({ title }).eq("id", topicId)).error);
    },
    async remove(topicId) {
      fail((await sb.from("topics").delete().eq("id", topicId)).error);
    },
    // 주제에 질문을 넣거나 뺀다. 다른 주제에 들어 있어도 상관없다.
    async setQuestion(topicId, questionId, on) {
      if (on) {
        const { error } = await sb.from("topic_questions")
          .upsert({ topic_id: topicId, question_id: questionId },
                  { onConflict: "topic_id,question_id" });
        fail(error);
      } else {
        const { error } = await sb.from("topic_questions").delete()
          .eq("topic_id", topicId).eq("question_id", questionId);
        fail(error);
      }
    },
  };

  const storage = {
    async upload(sessionId, ownerFolder, file) {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${sessionId}/${ownerFolder}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from("materials")
        .upload(path, file, { cacheControl: "3600", upsert: false });
      fail(error, "이미지를 올리지 못했습니다.");
      return path;
    },
    // 이 학급 폴더에 실제로 들어 있는 파일을 모두 훑습니다.
    //   경로 규칙: {세션id}/{teacher 또는 학생id}/{파일이름}
    //   저장소 규칙(RLS)상 담임 선생님만 자기 학급 폴더를 볼 수 있습니다.
    async listSessionFiles(sessionId) {
      const out = [];
      const { data: folders, error } = await sb.storage.from("materials")
        .list(sessionId, { limit: 200 });
      fail(error, "저장소를 읽지 못했습니다.");

      for (const f of folders || []) {
        if (f.id) continue;                 // id 가 있으면 폴더가 아니라 파일입니다
        let offset = 0;
        // 한 번에 100개씩, 더 없을 때까지 이어서 받습니다.
        for (;;) {
          const { data: files, error: e2 } = await sb.storage.from("materials")
            .list(`${sessionId}/${f.name}`, { limit: 100, offset });
          fail(e2, "저장소를 읽지 못했습니다.");
          for (const x of files || []) {
            if (!x.id) continue;            // 폴더는 건너뜁니다
            out.push({
              path: `${sessionId}/${f.name}/${x.name}`,
              size: Number(x.metadata?.size) || 0,
              createdAt: x.created_at || null,
            });
          }
          if (!files || files.length < 100) break;
          offset += 100;
        }
      }
      return out;
    },

    // 여러 파일을 한꺼번에 지웁니다. (100개씩 나눠 보냅니다)
    async removeMany(paths) {
      const list = (paths || []).filter(Boolean);
      let done = 0;
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const { error } = await sb.storage.from("materials").remove(chunk);
        fail(error, "파일을 지우지 못했습니다.");
        done += chunk.length;
      }
      return done;
    },

    async signedUrl(path) {
      const { data, error } = await sb.storage.from("materials").createSignedUrl(path, 3600);
      if (error) { console.warn(error); return undefined; }
      return data.signedUrl;
    },
  };

  /* ---------- 차시 (수업 회차) ---------- */
  const rounds = {
    async list(sessionId) {
      const { data, error } = await sb.from("session_rounds")
        .select("id, position, label, note, essay_topic, question_types, essay_open, inquiry_open")
        .eq("session_id", sessionId).order("position");
      fail(error);
      return (data || []).map((r) => ({
        id: r.id, label: r.label, note: r.note || "", essayTopic: r.essay_topic || "",
        // 빈 배열이면 '이 차시만의 설정 없음' 으로 봅니다.
        questionTypes: Array.isArray(r.question_types) && r.question_types.length
          ? r.question_types : null,
        essayOpen: r.essay_open === true,
        inquiryOpen: r.inquiry_open !== false,   // 예전 차시는 열린 것으로 봅니다
      }));
    },
    async create(sessionId, position, label) {
      const { data, error } = await sb.from("session_rounds")
        .insert({ session_id: sessionId, position, label })
        .select("id").single();
      fail(error);
      return data.id;
    },
    async update(roundId, patch) {
      const row = {};
      if (patch.label !== undefined) row.label = patch.label;
      if (patch.note !== undefined) row.note = patch.note;
      if (patch.essayTopic !== undefined) row.essay_topic = patch.essayTopic;
      if (patch.questionTypes !== undefined) row.question_types = patch.questionTypes || [];
      if (patch.essayOpen !== undefined) row.essay_open = !!patch.essayOpen;
      if (patch.inquiryOpen !== undefined) row.inquiry_open = !!patch.inquiryOpen;
      const { error } = await sb.from("session_rounds").update(row).eq("id", roundId);
      fail(error);
    },
    async remove(roundId) {
      const { error } = await sb.from("session_rounds").delete().eq("id", roundId);
      fail(error);
    },
  };

  /* ---------- 탐구 질문 ---------- */
  const inquiry = {
    // 차시마다 한 줄씩 있습니다. 한 번에 모두 받아 옵니다.
    async myDrafts(studentId) {
      const { data, error } = await sb.from("inquiry_drafts")
        .select("*").eq("student_id", studentId);
      fail(error);
      return data || [];
    },
    // 이미 있는 줄이면 '고치기'만 합니다.
    //   upsert 를 쓰면 줄이 이미 있어도 '새로 만들기' 권한까지 함께 검사합니다.
    //   그래서 승인 상태나 학급이 바뀐 학생은 고치는 것조차 막혀
    //   row-level security policy 오류가 났습니다.
    async saveDraft(sessionId, studentId, roundId, patch) {
      const { data: hit, error: e1 } = await sb.from("inquiry_drafts")
        .update({ ...patch })
        .eq("student_id", studentId).eq("round_id", roundId)
        .select("id");
      fail(e1);
      if (hit && hit.length) return;

      const { error: e2 } = await sb.from("inquiry_drafts")
        .insert({ session_id: sessionId, student_id: studentId, round_id: roundId, ...patch });
      if (!e2) return;
      // 같은 순간에 다른 탭이 먼저 만들었을 수 있으므로 한 번 더 고쳐 봅니다.
      if (e2.code === "23505") {
        const { error: e3 } = await sb.from("inquiry_drafts")
          .update({ ...patch }).eq("student_id", studentId).eq("round_id", roundId);
        fail(e3);
        return;
      }
      fail(e2);
    },
    // questions: [{ label, text }] — 유형별 질문을 한 번에 보냅니다.
    async evaluate(question, questions, roundId) {
      return callFunction("ai", {
        action: "evaluate_question", question, questions: questions || [], round_id: roundId,
      });
    },
    // qtype: 'reflective' | 'debate' | 'problem'
    async share(sessionId, studentId, body, qtype, roundId, isExtra, isPrivate) {
      const { data, error } = await sb.from("shared_questions")
        .insert({
          session_id: sessionId, student_id: studentId, body,
          qtype: qtype || "", round_id: roundId || null, is_extra: !!isExtra,
          is_private: !!isPrivate,
        })
        .select("id").single();
      fail(error);
      return data.id;
    },

    // 이 차시에 내가 이미 공유한 질문들
    async myShared(studentId, roundId) {
      let q = sb.from("shared_questions")
        .select("id, body, qtype, is_extra, is_private, approved_for_explore, approved_for_discussion")
        .eq("student_id", studentId)
        .order("id", { ascending: true });
      q = roundId ? q.eq("round_id", roundId) : q.is("round_id", null);
      const { data, error } = await q;
      fail(error);
      return data || [];
    },

    // 공유하기를 다시 눌렀을 때 쓰는 함수.
    //   같은 차시에 이미 올라간 질문은 '새로 만들지 않고 고칩니다'.
    //   · 유형 질문(성찰/논쟁/문제해결) → 같은 유형끼리 짝을 지어 내용만 바꿉니다.
    //   · '질문 더하기' 질문        → 올린 순서대로 짝을 지어 내용만 바꿉니다.
    //   짝이 남으면 새로 만들고, 학생이 지운 질문은 함께 지웁니다.
    //   다만 선생님이 이미 승인한 질문은 지우지 않습니다.
    //   (탐구하기·AI 토론에 이미 쓰이고 있어서, 지우면 그 기록까지 사라지기 때문입니다.)
    async syncShare(sessionId, studentId, roundId, typed, extras) {
      const before = await this.myShared(studentId, roundId);
      const used = new Set();
      let added = 0, updated = 0, removed = 0, kept = 0;

      // patch 에 body 말고 is_private 처럼 함께 고칠 값을 더 넘길 수 있습니다.
      const reuse = (row, body, patch) => {
        used.add(row.id);
        const next = Object.assign({ body }, patch || {});
        const same = Object.keys(next).every((k) => (row[k] ?? "") === (next[k] ?? ""));
        if (same) return;
        return sb.from("shared_questions").update(next).eq("id", row.id)
          .then(({ error }) => { fail(error); updated += 1; });
      };

      // 1) 유형 질문: 같은 유형의 기존 줄을 찾아 고친다.
      for (const o of typed || []) {
        const hit = before.find((r) => !r.is_extra && r.qtype === o.k && !used.has(r.id));
        if (hit) { await reuse(hit, o.text, { is_private: false }); }
        else { await this.share(sessionId, studentId, o.text, o.k, roundId, false, false); added += 1; }
      }

      // 2) 질문 더하기: 올린 순서대로 짝을 짓는다.
      const oldExtras = before.filter((r) => r.is_extra && !used.has(r.id));
      //  예전에 저장해 둔 글자 목록도 그대로 읽습니다. (["질문", ...])
      const list = (extras || []).map((x) => (typeof x === "string"
        ? { text: x, private: false }
        : { text: (x && x.text) || "", private: !!(x && x.private) }))
        .filter((x) => x.text);
      for (let i = 0; i < list.length; i += 1) {
        if (oldExtras[i]) { await reuse(oldExtras[i], list[i].text, { is_private: list[i].private }); }
        else {
          await this.share(sessionId, studentId, list[i].text, "", roundId, true, list[i].private);
          added += 1;
        }
      }

      // 3) 학생이 지운 질문은 함께 지운다. (승인된 것은 남긴다)
      const leftovers = before.filter((r) => !used.has(r.id));
      const deletable = leftovers
        .filter((r) => !r.approved_for_explore && !r.approved_for_discussion)
        .map((r) => r.id);
      kept = leftovers.length - deletable.length;
      if (deletable.length) {
        const { error } = await sb.from("shared_questions").delete().in("id", deletable);
        fail(error);
        removed = deletable.length;
      }
      return { added, updated, removed, kept };
    },
    async feed(sessionId) {
      const { data, error } = await sb.rpc("get_shared_questions", { p_session: sessionId });
      fail(error);
      return (data || []).map((q) => ({ ...q, comments: q.comments || [] }));
    },
    async toggleReaction(questionId, kind) {
      const { data, error } = await sb.rpc("toggle_reaction", {
        p_question: questionId, p_kind: kind,
      });
      fail(error);
      return data;
    },
    async comment(questionId, studentId, body) {
      const { error } = await sb.from("question_comments")
        .insert({ question_id: questionId, student_id: studentId, body });
      fail(error);
    },
    // 차시를 닫을 때 질문을 정리합니다.
    //   안 낸 학생은 만들어 둔 질문을 그대로 공유, 고치던 학생은 냈던 내용으로 되돌림.
    async finalizeRound(roundId) {
      const { data, error } = await sb.rpc("finalize_round_inquiry", { p_round: roundId });
      fail(error);
      return Number(data) || 0;
    },
    // 공개 / 비공개 바꾸기 (질문을 낸 학생 본인, 또는 담임 선생님)
    async setPrivate(questionId, on) {
      const { error } = await sb.from("shared_questions")
        .update({ is_private: !!on }).eq("id", questionId);
      fail(error);
    },
    // 질문 지우기 (담임 선생님. 부적절한 질문을 내렸을 때 씁니다)
    //   반응·댓글·AI 토론 기록은 창고에서 함께 지워집니다.
    async remove(questionId) {
      const { error } = await sb.from("shared_questions").delete().eq("id", questionId);
      fail(error);
    },
    // kind: 'explore' (탐구하기용) | 'discuss' (AI 토론하기용)
    async setApproved(questionId, kind, on) {
      const column = kind === "explore" ? "approved_for_explore" : "approved_for_discussion";
      const { error } = await sb.from("shared_questions")
        .update({ [column]: on }).eq("id", questionId);
      fail(error);
    },
  };

  /* ---------- AI 토론 ---------- */
  const discussion = {
    async load(studentId, questionId) {
      const { data: d, error } = await sb.from("discussions")
        .select("id, stance").eq("student_id", studentId).eq("question_id", questionId).maybeSingle();
      fail(error);
      if (!d) return { stance: null, messages: [] };
      const { data: msgs } = await sb.from("discussion_messages")
        .select("role, content, created_at").eq("discussion_id", d.id)
        .order("created_at", { ascending: true });
      return {
        stance: d.stance,
        messages: (msgs || []).map((m) => ({ role: m.role === "ai" ? "ai" : "user", text: m.content })),
      };
    },
    // 글쓰기 화면에서 "지금까지 나눈 토론"을 모두 불러올 때 사용
    async loadAll(studentId) {
      const { data: ds } = await sb.from("discussions")
        .select("id, question_id, stance").eq("student_id", studentId);
      const out = {};
      if (!ds || !ds.length) return out;
      const { data: msgs } = await sb.from("discussion_messages")
        .select("discussion_id, role, content, created_at")
        .in("discussion_id", ds.map((d) => d.id))
        .order("created_at", { ascending: true });
      ds.forEach((d) => {
        out[d.question_id] = (msgs || [])
          .filter((m) => m.discussion_id === d.id)
          .map((m) => ({ role: m.role === "ai" ? "ai" : "user", text: m.content }));
        out[`stance:${d.question_id}`] = d.stance;
      });
      return out;
    },

    async send({ questionId, stance, message }) {
      const out = await callFunction("ai", {
        action: "discuss", question_id: questionId, stance, message,
      });
      return {
        stance: out.stance,
        messages: (out.messages || []).map((m) => ({
          role: m.role === "ai" ? "ai" : "user", text: m.content,
        })),
      };
    },
  };

  /* ---------- 글쓰기 ---------- */
  const essay = {
    // 교사용 : 이 세션의 모든 글쓰기를 학생·차시별로 받아 옵니다.
    //   (본문 전체가 아니라 제출 여부와 미리보기만 씁니다)
    async sessionRows(sessionId) {
      const { data, error } = await sb.from("essays")
        .select("student_id, round_id, submitted, body, steps, submit_count, submit_log")
        .eq("session_id", sessionId);
      fail(error);
      return data || [];
    },
    // 차시마다 한 줄씩 있습니다. 한 번에 모두 받아 옵니다.
    async mineAll(studentId) {
      const { data, error } = await sb.from("essays")
        .select("*").eq("student_id", studentId);
      fail(error);
      return data || [];
    },
    async save(sessionId, studentId, roundId, patch) {
      const { error } = await sb.from("essays")
        .upsert({ session_id: sessionId, student_id: studentId, round_id: roundId, ...patch },
                { onConflict: "student_id,round_id" });
      fail(error);
    },
    // 선생님이 글쓰기를 열 때, 그 전에 써 둔 글을 모두 지웁니다. (담임 선생님만)
    // 차시를 닫을 때 학생들의 글을 정리합니다.
    //   안 낸 학생은 쓴 만큼 제출 처리, 고치던 학생은 냈던 글로 되돌림.
    async finalizeRound(roundId) {
      const { data, error } = await sb.rpc("finalize_round_essays", { p_round: roundId });
      fail(error);
      return Number(data) || 0;
    },
    async clearSession(sessionId, roundId) {
      const { data, error } = await sb.rpc("clear_session_essays",
        { p_session: sessionId, p_round: roundId || null });
      fail(error);
      return Number(data) || 0;
    },
  };

  /* ---------- 생기부 초안 ---------- */
  const records = {
    async generate(studentId) {
      return callFunction("ai", { action: "record_draft", student_id: studentId });
    },
    async save(sessionId, studentId, body) {
      const { error } = await sb.from("record_drafts")
        .upsert({ session_id: sessionId, student_id: studentId, body }, { onConflict: "student_id" });
      fail(error);
    },
  };

  /* ---------- 교사 Gemini 키 ---------- */
  const keys = {
    async status() { return callFunction("ai", { action: "key_status" }); },
    // 키로 실제 쓸 수 있는 모델 목록까지 확인 (문제를 찾을 때 씁니다)
    async check() { return callFunction("ai", { action: "key_status", check: true }); },
    async set(geminiKey) { return callFunction("ai", { action: "set_key", gemini_key: geminiKey }); },
  };

  // 로그인 토큰이 살아 있는지 확인하고, 만료가 가까우면 새로 받아 옵니다.
  //   (탭을 오래 열어 두거나 노트북이 절전에 들어가면 갱신 시각을 놓칠 수 있습니다)
  async function ensureFreshSession() {
    const { data } = await sb.auth.getSession();
    const sess = data.session;
    if (!sess) return false;
    const left = (sess.expires_at || 0) * 1000 - Date.now();
    if (left > 120_000) return true;          // 2분 넘게 남았으면 그대로 씁니다
    const { data: r } = await sb.auth.refreshSession();
    return !!(r && r.session);
  }

  window.QLab = {
    sb, fmtDate, fmtDateTime, callFunction, ensureFreshSession,
    auth, adminCodes, sessions, courses, students, words, materials, storage,
    inquiry, topics, discussion, essay, records, keys, rounds,
  };
})();
