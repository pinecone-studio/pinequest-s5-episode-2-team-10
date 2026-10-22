// Shapes shared with the FastAPI server (TDD v2, /api/v1).
// Keep in sync with server/ models and the JSON contract.

export type PitchType = "startup" | "academic";

export type FeedbackBackend = "gemma4-ft" | "gemma4-base" | "claude";

export type SessionStatus =
  | "created"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed";

export type Stage =
  | "transcribing"
  | "measuring"
  | "slides"
  | "feedback"
  | "scoring";

export interface CreateSessionBody {
  title: string;
  goal: string;
  audience: string;
  planned_s: number;
  pitch_type: PitchType;
  group_id?: string | null;
}

export interface CreatedSession {
  id: string;
  access_token: string;
}

export interface SlidesUploadResult {
  slide_count: number;
  image_only: number[];
}

export interface AudioUploadResult {
  duration_s: number;
  format: string;
}

export interface StatusResponse {
  status: SessionStatus;
  stage: Stage | null;
  queue_position: number | null;
  error: string | null;
}

export interface Sentence {
  text: string;
  start: number;
  end: number;
}

export interface ContentScore {
  criterion: string;
  score: number;
  evidence: string;
  recommendation: string;
}

export interface SlideFeedback {
  slide: number;
  status: "covered" | "missed" | "partial" | "image_only";
  comment: string;
}

export interface NumberCheck {
  slide: number;
  on_slide: string;
  said: string | null;
  inconsistent: boolean;
}

export interface Recommendation {
  area: string;
  problem: string;
  start_s: number | null;
  slide: number | null;
  why: string;
  action: string;
  example_sentence: string;
  impact: "high" | "medium" | "low";
}

export interface Feedback {
  summary: string;
  strengths: string[];
  content_scores: ContentScore[];
  slide_feedback: SlideFeedback[];
  number_checks: NumberCheck[];
  recommendations: Recommendation[];
}

export interface Metrics {
  duration_s: number;
  wpm: number | null;
  fillers_per_100: number | null;
  long_pauses_per_min: number | null;
  pitch_range_st: number | null;
  end_volume_drop_db: number | null;
}

export interface Report {
  session_id: string;
  title: string;
  overall: number | null;
  content: number | null;
  delivery: number | null;
  slide_alignment: number | null;
  timing: number | null;
  metrics: Metrics;
  feedback: Feedback;
  transcript: { text: string; sentences: Sentence[] };
  backend: FeedbackBackend;
  created_at: string;
}

export interface ApiError {
  code: string;
  message: string;
}
