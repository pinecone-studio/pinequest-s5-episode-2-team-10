// In-browser stand-in for the FastAPI server, used when NEXT_PUBLIC_API_URL is unset.
// Projects and attempts live in local storage; analysis walks through the real stages on a
// timer and returns a sample report. Recordings are kept in memory only (lost on reload).

import type {
  Attempt,
  FeedbackBackend,
  Project,
  ProjectDetails,
  ProjectSummary,
  Report,
  SessionStatus,
  Stage,
  StatusResponse,
} from "./types";

interface MockProject extends ProjectDetails {
  id: string;
  created_at: string;
  updated_at: string;
}

interface MockSession {
  id: string;
  project_id: string;
  seq: number;
  created_at: string;
  title: string;
  planned_s: number;
  status: SessionStatus;
  analyzeAt: number | null;
  backend: FeedbackBackend;
  durationS: number;
  slidesFilename: string | null;
  slideCount: number;
  script: string;
}

interface Store {
  projects: Record<string, MockProject>;
  sessions: Record<string, MockSession>;
}

const STAGES: Stage[] = ["transcribing", "measuring", "slides", "feedback", "scoring"];
const STAGE_MS = 1500;
const KEY = "pitchcoach:mock:v2";
const audioBlobs = new Map<string, Blob>();

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const notFound = (what: string) => ({ code: "not_found", message: `${what} not found.` });

function load(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "") as Store;
  } catch {
    return { projects: {}, sessions: {} };
  }
}

function save(store: Store) {
  localStorage.setItem(KEY, JSON.stringify(store));
}

function liveStatus(s: MockSession): { status: SessionStatus; stage: Stage | null } {
  if (s.status !== "processing" || !s.analyzeAt) return { status: s.status, stage: null };
  const i = Math.floor((Date.now() - s.analyzeAt) / STAGE_MS);
  if (i >= STAGES.length) return { status: "completed", stage: null };
  return { status: "processing", stage: STAGES[i] };
}

function attempt(s: MockSession): Attempt {
  const { status, stage } = liveStatus(s);
  return {
    id: s.id,
    created_at: s.created_at,
    status,
    stage,
    error: null,
    backend: s.analyzeAt ? s.backend : null,
    overall: status === "completed" ? sampleReport(s).overall : null,
    duration_s: s.durationS || null,
    slides_filename: s.slidesFilename,
    slide_count: s.slideCount,
    has_script: !!s.script.trim(),
  };
}

function projectSessions(store: Store, id: string): MockSession[] {
  return Object.values(store.sessions)
    .filter((s) => s.project_id === id)
    .sort((a, b) => b.seq - a.seq);
}

function summary(store: Store, p: MockProject): ProjectSummary {
  const sessions = projectSessions(store, p.id);
  const analyzed = sessions.filter((s) => s.analyzeAt);
  const done = analyzed.find((s) => liveStatus(s).status === "completed");
  return {
    ...p,
    attempt_count: analyzed.length,
    latest_overall: done ? sampleReport(done).overall : null,
    processing: analyzed.some((s) => liveStatus(s).status === "processing"),
  };
}

function full(store: Store, p: MockProject): Project {
  const sessions = projectSessions(store, p.id);
  const latest = sessions[0];
  return {
    ...summary(store, p),
    attempts: sessions.filter((s) => s.analyzeAt).map(attempt),
    current: {
      slides_filename: latest?.slidesFilename ?? null,
      slide_count: latest?.slideCount ?? 0,
      script: latest?.script ?? "",
    },
  };
}

function getProjectRow(store: Store, id: string): MockProject {
  const p = store.projects[id];
  if (!p) throw notFound("Project");
  return p;
}

function getSession(store: Store, id: string): MockSession {
  const s = store.sessions[id];
  if (!s) throw notFound("Attempt");
  return s;
}

export const mockApi = {
  async listProjects() {
    await wait();
    const store = load();
    return Object.values(store.projects)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((p) => summary(store, p));
  },

  async createProject(details: Partial<ProjectDetails> = {}) {
    await wait();
    const store = load();
    const p: MockProject = {
      id: crypto.randomUUID(),
      name: details.name?.trim() || "Untitled project",
      goal: details.goal ?? "",
      audience: details.audience ?? "",
      idea: details.idea ?? "",
      key_points: details.key_points ?? [],
      planned_s: details.planned_s ?? 180,
      pitch_type: details.pitch_type ?? "startup",
      created_at: now(),
      updated_at: now(),
    };
    store.projects[p.id] = p;
    save(store);
    return full(store, p);
  },

  async getProject(id: string) {
    await wait(150);
    const store = load();
    return full(store, getProjectRow(store, id));
  },

  async updateProject(id: string, patch: Partial<ProjectDetails>) {
    await wait(150);
    const store = load();
    const p = getProjectRow(store, id);
    Object.assign(p, patch, { updated_at: now() });
    if (!p.name.trim()) p.name = "Untitled project";
    save(store);
    return full(store, p);
  },

  async deleteProject(id: string) {
    await wait();
    const store = load();
    for (const s of projectSessions(store, id)) delete store.sessions[s.id];
    delete store.projects[id];
    save(store);
  },

  async createAttempt(projectId: string) {
    await wait();
    const store = load();
    const p = getProjectRow(store, projectId);
    const prev = projectSessions(store, projectId)[0];
    const s: MockSession = {
      id: crypto.randomUUID(),
      project_id: projectId,
      seq: (prev?.seq ?? 0) + 1,
      created_at: now(),
      title: p.name,
      planned_s: p.planned_s,
      status: "created",
      analyzeAt: null,
      backend: "claude",
      durationS: 0,
      slidesFilename: prev?.slidesFilename ?? null,
      slideCount: prev?.slideCount ?? 0,
      script: prev?.script ?? "",
    };
    store.sessions[s.id] = s;
    p.updated_at = now();
    save(store);
    return attempt(s);
  },

  async deleteAttempt(id: string) {
    const store = load();
    delete store.sessions[id];
    save(store);
  },

  async uploadSlides(id: string, file: File) {
    await wait(500);
    const store = load();
    const s = getSession(store, id);
    s.slidesFilename = file.name;
    s.slideCount = 8;
    save(store);
    return { slide_count: 8, image_only: [6], filename: file.name };
  },

  async removeSlides(id: string) {
    const store = load();
    const s = getSession(store, id);
    s.slidesFilename = null;
    s.slideCount = 0;
    save(store);
  },

  async setScript(id: string, text: string) {
    const store = load();
    getSession(store, id).script = text.trim();
    save(store);
    return { words: text.trim().split(/\s+/).filter(Boolean).length };
  },

  async uploadAudio(id: string, file: Blob) {
    await wait(500);
    const store = load();
    const s = getSession(store, id);
    s.durationS = await audioDuration(file);
    s.status = "uploaded";
    audioBlobs.set(id, file);
    save(store);
    return { duration_s: s.durationS, format: file.type || "unknown" };
  },

  async analyze(id: string, backend: FeedbackBackend) {
    await wait();
    const store = load();
    const s = getSession(store, id);
    if (s.status === "created") throw { code: "no_audio", message: "Upload or record audio first." };
    const p = getProjectRow(store, s.project_id);
    Object.assign(s, { title: p.name, planned_s: p.planned_s, status: "processing", analyzeAt: Date.now(), backend });
    p.updated_at = now();
    save(store);
  },

  async status(id: string): Promise<StatusResponse> {
    const s = getSession(load(), id);
    const { status, stage } = liveStatus(s);
    return { status, stage, queue_position: status === "processing" ? 0 : null, error: null };
  },

  async report(id: string): Promise<Report> {
    await wait();
    return sampleReport(getSession(load(), id));
  },

  async audioBlob(id: string): Promise<Blob> {
    const blob = audioBlobs.get(id);
    if (!blob) throw { code: "not_found", message: "Recordings aren't kept after a reload in demo mode." };
    return blob;
  },

  async slidesText(id: string) {
    const s = getSession(load(), id);
    return {
      filename: s.slidesFilename,
      slides: Array.from({ length: s.slideCount }, (_, i) => ({
        number: i + 1,
        text: i === 5 ? "" : `Sample text for slide ${i + 1}`,
        notes: "",
        image_only: i === 5,
      })),
    };
  },

  async slidesFile(): Promise<Blob> {
    throw { code: "not_found", message: "Slide files aren't stored in demo mode." };
  },
};

async function audioDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const el = new Audio(URL.createObjectURL(file));
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : 120);
    el.onerror = () => resolve(120);
  });
}

function sampleReport(s: MockSession): Report {
  const hasSlides = s.slideCount > 0;
  const content = 58 + ((s.seq * 7) % 30);
  const delivery = 52 + ((s.seq * 11) % 35);
  const slide_alignment = hasSlides ? 75 : null;
  const timingOff = Math.abs(s.durationS - s.planned_s) / s.planned_s;
  const timing = Math.round(Math.max(0, Math.min(1, (0.5 - timingOff) / 0.4)) * 100);

  const parts: [number | null, number][] = [
    [content, 0.35],
    [delivery, 0.3],
    [slide_alignment, 0.25],
    [timing, 0.1],
  ];
  const used = parts.filter(([v]) => v !== null) as [number, number][];
  const wsum = used.reduce((a, [, w]) => a + w, 0);
  const overall = Math.round(used.reduce((a, [v, w]) => a + v * w, 0) / wsum);

  return {
    session_id: s.id,
    title: s.title,
    overall,
    content,
    delivery,
    slide_alignment,
    timing,
    backend: s.backend,
    script: s.script,
    slides_filename: s.slidesFilename,
    notes: ["Demo mode: this is sample feedback, not an analysis of your recording."],
    created_at: new Date().toISOString(),
    metrics: {
      duration_s: s.durationS,
      wpm: 162,
      fillers_per_100: 3.4,
      long_pauses_per_min: 1.2,
      pitch_range_st: 5.1,
      end_volume_drop_db: 4.0,
    },
    transcript: {
      text: "",
      sentences: [
        { text: "Сайн байна уу, бид бол Team 10.", start: 0, end: 2.8 },
        { text: "Ээ, өнөөдөр бид оюутнуудын нэг том асуудлыг шийдэх тухай ярина.", start: 3.1, end: 8.4 },
        { text: "Монголын оюутнуудын гучин хувь нь илтгэл тавихаас айдаг.", start: 8.9, end: 13.2 },
        { text: "Манай апп таны илтгэлийг сонсоод зөвлөгөө өгнө.", start: 13.6, end: 17.9 },
      ],
    },
    feedback: {
      summary:
        "Асуудлыг тодорхой хэлсэн ч зорилтот хэрэглэгч болон дуудлага (call to action) сул байна. Хэлэх хурд жаахан хурдан.",
      strengths: ["Эхний 10 секундэд асуудлаа хэлсэн", "Жишээ тоо ашигласан"],
      content_scores: [
        { criterion: "problem", score: 80, evidence: "оюутнуудын нэг том асуудлыг шийдэх", recommendation: "Асуудлыг нэг тоогоор баталгаажуул." },
        { criterion: "solution", score: 72, evidence: "Манай апп таны илтгэлийг сонсоод зөвлөгөө өгнө.", recommendation: "Хэрхэн ажилладгийг нэг өгүүлбэрээр нэм." },
        { criterion: "target_user", score: 55, evidence: "оюутнууд", recommendation: "Ямар оюутан гэдгийг нарийвчил." },
        { criterion: "value", score: 64, evidence: "зөвлөгөө өгнө", recommendation: "Бусад аргаас юугаараа ялгаатайг хэл." },
        { criterion: "logical_order", score: 74, evidence: "", recommendation: "" },
        { criterion: "conclusion_cta", score: 40, evidence: "", recommendation: "Төгсгөлд тодорхой хүсэлт хэл." },
      ],
      slide_feedback: hasSlides
        ? [
            { slide: 1, status: "covered", comment: "" },
            { slide: 2, status: "covered", comment: "" },
            { slide: 3, status: "partial", comment: "Зах зээлийн хэмжээг хэлээгүй." },
            { slide: 4, status: "covered", comment: "" },
            { slide: 5, status: "missed", comment: "Өрсөлдөгчийн слайдыг алгассан." },
            { slide: 6, status: "image_only", comment: "" },
            { slide: 7, status: "covered", comment: "" },
            { slide: 8, status: "partial", comment: "Багийн танилцуулга богино." },
          ]
        : [],
      number_checks: hasSlides
        ? [{ slide: 3, on_slide: "25%", said: "гучин хувь", inconsistent: true }]
        : [],
      recommendations: [
        {
          area: "structure",
          problem: "Төгсгөлд дуудлага (call to action) байхгүй.",
          start_s: null,
          slide: hasSlides ? 8 : null,
          why: "Шүүгчид юу хийхийг хүсч байгааг мэдэхгүй үлдэнэ.",
          action: "Сүүлийн 10 секундэд нэг тодорхой хүсэлт хэл.",
          example_sentence: "Бид 3 сарын турш 100 оюутантай туршилт хийхэд таны дэмжлэг хэрэгтэй.",
          impact: "high",
        },
        {
          area: "accuracy",
          problem: "Слайд дээр 25% гэсэн ч 'гучин хувь' гэж хэлсэн.",
          start_s: 8.9,
          slide: hasSlides ? 3 : null,
          why: "Тоо зөрөх нь итгэлийг бууруулна.",
          action: "Слайд болон ярианы тоог нэгтгэ.",
          example_sentence: "Монголын оюутнуудын 25 хувь нь илтгэл тавихаас айдаг.",
          impact: "medium",
        },
        {
          area: "delivery",
          problem: "Минутанд 162 үг, зөвлөмжөөс хурдан.",
          start_s: 3.1,
          slide: null,
          why: "Сонсогч гол санааг алдаж магадгүй.",
          action: "Гол тооны дараа 1 секунд завсарла.",
          example_sentence: "",
          impact: "medium",
        },
      ],
    },
  };
}
