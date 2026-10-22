// In-browser stand-in for the FastAPI server, used when NEXT_PUBLIC_API_URL is unset.
// It walks through the real stages on a timer and returns a sample report.

import type {
  CreateSessionBody,
  FeedbackBackend,
  Report,
  Stage,
  StatusResponse,
} from "./types";

interface MockSession extends CreateSessionBody {
  id: string;
  hasAudio: boolean;
  slideCount: number;
  durationS: number;
  analyzeAt: number | null;
  backend: FeedbackBackend;
}

const STAGES: Stage[] = ["transcribing", "measuring", "slides", "feedback", "scoring"];
const STAGE_MS = 1500;
const key = (id: string) => `pitchcoach:mock:${id}`;

function load(id: string): MockSession {
  const raw = localStorage.getItem(key(id));
  if (!raw) throw { code: "not_found", message: "Session not found." };
  return JSON.parse(raw);
}

function save(s: MockSession) {
  localStorage.setItem(key(s.id), JSON.stringify(s));
}

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

export const mockApi = {
  async createSession(body: CreateSessionBody) {
    await wait();
    const id = crypto.randomUUID();
    save({ ...body, id, hasAudio: false, slideCount: 0, durationS: 0, analyzeAt: null, backend: "claude" });
    return { id, access_token: "mock" };
  },

  async uploadSlides(id: string) {
    await wait(600);
    const s = load(id);
    s.slideCount = 8;
    save(s);
    return { slide_count: 8, image_only: [6] };
  },

  async uploadAudio(id: string, file: Blob) {
    await wait(600);
    const s = load(id);
    s.hasAudio = true;
    s.durationS = await audioDuration(file);
    save(s);
    return { duration_s: s.durationS, format: file.type || "unknown" };
  },

  async analyze(id: string, backend: FeedbackBackend) {
    await wait();
    const s = load(id);
    if (!s.hasAudio) throw { code: "no_audio", message: "Upload or record audio first." };
    s.analyzeAt = Date.now();
    s.backend = backend;
    save(s);
  },

  async status(id: string): Promise<StatusResponse> {
    const s = load(id);
    if (!s.analyzeAt) {
      return { status: s.hasAudio ? "uploaded" : "created", stage: null, queue_position: null, error: null };
    }
    const i = Math.floor((Date.now() - s.analyzeAt) / STAGE_MS);
    if (i >= STAGES.length) return { status: "completed", stage: null, queue_position: null, error: null };
    return { status: "processing", stage: STAGES[i], queue_position: 0, error: null };
  },

  async report(id: string): Promise<Report> {
    await wait();
    return sampleReport(load(id));
  },

  async deleteSession(id: string) {
    localStorage.removeItem(key(id));
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
  const content = 68;
  const delivery = 61;
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
