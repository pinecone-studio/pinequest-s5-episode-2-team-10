// Shapes shared with the FastAPI server (TDD v2, /api/v1).
// Keep in sync with server/ models and the JSON contract.

export type AppRole = "member" | "admin";

export interface AccountProfile {
  id: string;
  email: string;
  /** Null for Google, demo, and older accounts. */
  username: string | null;
  role: AppRole;
  /** False for accounts that only sign in with Google. Sent by /auth/me, not by sign-in. */
  has_password?: boolean;
}

export interface AuthSession extends AccountProfile {
  access_token: string;
}

export interface AdminUser {
  id: string;
  email: string | null;
  role: AppRole;
  is_active: boolean;
  created_at: string;
}

export type PitchType = "startup" | "academic";

// "rules" is server-side only (no model, offline testing); the UI never offers it.
export type FeedbackBackend = "gemma4-ft" | "gemma4-base" | "claude" | "rules";

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

export interface ProjectDetails {
  name: string;
  goal: string;
  audience: string;
  idea: string;
  key_points: string[]; // up to 6 main points the speech should get across
  point_slides?: (number | null)[];
  figma_url?: string | null;
  script?: string;
  selected_audio_id?: string | null;
  planned_s: number;
  pitch_type: PitchType;
}

export interface ProjectSummary extends ProjectDetails {
  id: string;
  owner_id?: string;
  owner_email?: string | null;
  created_at: string;
  updated_at: string;
  attempt_count: number;
  latest_overall: number | null;
  processing: boolean;
}

// One analysis inside a project.
export interface Attempt {
  id: string;
  created_at: string;
  status: SessionStatus;
  stage: Stage | null;
  error: string | null;
  backend: FeedbackBackend | null;
  overall: number | null;
  duration_s: number | null;
  slides_filename: string | null;
  audio_filename?: string | null;
  has_audio?: boolean;
  slide_count: number;
  has_script: boolean;
}

export interface Project extends ProjectSummary {
  attempts: Attempt[];
  // Slides and script the next attempt reuses (from the latest attempt).
  current: { slides_filename: string | null; slide_count: number; script: string; session_id?: string | null };
}

export interface SlidesUploadResult {
  slide_count: number;
  image_only: number[];
  filename: string;
}

export interface SlideText {
  number: number;
  text: string;
  notes: string;
  image_only: boolean;
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

export interface PracticeTask {
  title: string;
  instruction: string;
  goal: string;
}

export interface Feedback {
  summary: string;
  strengths: string[];
  content_scores: ContentScore[];
  slide_feedback: SlideFeedback[];
  number_checks: NumberCheck[];
  recommendations: Recommendation[];
  // Absent on reports created before practice tasks were added.
  practice_tasks?: PracticeTask[];
  // Missing on reports made before main points existed.
  main_points?: MainPoints;
}

// Did the speech make the project's main points? Quotes are checked and coverage computed in code.
export interface MainPoints {
  method: "llm" | "words";
  points: {
    point: number;
    text: string;
    status: "covered" | "partial" | "missed";
    verified: boolean; // false: the model's quote wasn't in the transcript, so it counts as missed
    evidence: string;
    note: string;
  }[];
  coverage: number | null;
  off_topic: { sentence_id: number; start: number | null; text: string; reason: string }[];
  idea_comment: string;
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
  script: string;
  slides_filename: string | null;
  backend: FeedbackBackend;
  notes: string[];
  created_at: string;
}

export interface ApiError {
  code: string;
  message: string;
}
