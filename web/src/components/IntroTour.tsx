"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MessageKey } from "@/lib/i18n";
import { useLang } from "@/lib/i18nClient";
import { Emphasis } from "./Landing";
import SayloMark from "./SayloMark";

type Item = { icon: ReactNode; label: string; text: string };
type Step = { title: MessageKey; body: MessageKey; visual: ReactNode; items: Item[] };

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A short guided tour of the signed-in app: one card per area, a picture of it on the left and
 * what each control does on the right. Arrow keys move between steps; Escape closes.
 */
export default function IntroTour({ onClose }: { onClose: () => void }) {
  const { tr } = useLang();
  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState(0);

  const steps: Step[] = [
    {
      title: "intro1Title",
      body: "intro1Body",
      visual: <WelcomeVisual labels={[tr("landingStep1Title"), tr("landingStep2Title"), tr("landingStep3Title")]} />,
      items: [
        { icon: <Num n={1} />, label: tr("landingStep1Title"), text: tr("landingStep1Body") },
        { icon: <Num n={2} />, label: tr("landingStep2Title"), text: tr("landingStep2Body") },
        { icon: <Num n={3} />, label: tr("landingStep3Title"), text: tr("landingStep3Body") },
      ],
    },
    {
      title: "intro2Title",
      body: "intro2Body",
      visual: <AddVisual label={tr("addFolder")} />,
      items: [
        { icon: <PlusIcon />, label: tr("addFolder"), text: tr("intro2Item1") },
        { icon: <LinkIcon />, label: tr("intro2Item2Label"), text: tr("intro2Item2") },
        { icon: <CardIcon />, label: tr("intro2Item3Label"), text: tr("intro2Item3") },
      ],
    },
    {
      title: "intro3Title",
      body: "intro3Body",
      visual: <SideVisual title={tr("folders")} rename={tr("renamePitch")} remove={tr("deleteFolder")} />,
      items: [
        { icon: <FolderIcon />, label: tr("folders"), text: tr("intro3Item1") },
        { icon: <MoreIcon />, label: `${tr("renamePitch")} / ${tr("deleteFolder")}`, text: tr("intro3Item2") },
        { icon: <SayloMark />, label: tr("intro3Item3Label"), text: tr("intro3Item3") },
      ],
    },
    {
      title: "intro4Title",
      body: "intro4Body",
      visual: <SlideVisual speak={tr("speak")} camera={tr("cameraOpen")} full={tr("fullscreen")} prev={tr("prev")} next={tr("next")} />,
      items: [
        { icon: <MicIcon />, label: tr("speak"), text: tr("intro4Item1") },
        { icon: <CameraIcon />, label: tr("cameraOpen"), text: tr("intro4Item2") },
        { icon: <ExpandIcon />, label: tr("fullscreen"), text: tr("intro4Item3") },
        { icon: <ArrowsIcon />, label: tr("intro4Item4Label"), text: tr("intro4Item4") },
      ],
    },
    {
      title: "intro5Title",
      body: "intro5Body",
      visual: <SpeechVisual title={tr("speechText")} saved={tr("speechSaved")} analyze={tr("sendToModel")} result={tr("showResult")} />,
      items: [
        { icon: <TextIcon />, label: tr("speechText"), text: tr("intro5Item1") },
        { icon: <RedoIcon />, label: tr("retranscribeAudio"), text: tr("intro5Item2") },
        { icon: <SparkIcon />, label: tr("sendToModel"), text: tr("intro5Item3") },
        { icon: <PlayIcon />, label: tr("showResult"), text: tr("intro5Item4") },
      ],
    },
    {
      title: "intro6Title",
      body: "intro6Body",
      visual: <AccountVisual intro={tr("introOpen")} admin={tr("adminPanel")} logout={tr("logOut")} />,
      items: [
        { icon: <UserIcon />, label: tr("intro6Item1Label"), text: tr("intro6Item1") },
        { icon: <BookIcon />, label: tr("introOpen"), text: tr("intro6Item2") },
        { icon: <ExitIcon />, label: tr("logOut"), text: tr("intro6Item3") },
      ],
    },
  ];
  const step = steps[index];
  const last = index === steps.length - 1;

  useEffect(() => {
    nextRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowRight") setIndex((i) => Math.min(steps.length - 1, i + 1));
      if (event.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (event.key !== "Tab" || !cardRef.current) return;
      const items = [...cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const end = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        end.focus();
      } else if (!event.shiftKey && document.activeElement === end) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, steps.length]);

  return createPortal(
    <div className="intro">
      <button type="button" className="intro-backdrop" aria-label={tr("close")} tabIndex={-1} onClick={onClose} />
      <div ref={cardRef} className="intro-card" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}>
        <button type="button" className="intro-x" aria-label={tr("close")} onClick={onClose}>
          <CloseIcon />
        </button>
        <div className="intro-visual" aria-hidden>
          <div key={index} className="intro-visual-inner">
            {step.visual}
          </div>
        </div>
        <div className="intro-body">
          <div key={index} className="intro-copy">
            <span className="intro-chip" aria-live="polite">
              {tr("introOpen")} · {tr("introStepOf", { step: index + 1, count: steps.length })}
            </span>
            <h2 id={titleId}>
              <Emphasis text={tr(step.title)} />
            </h2>
            <p id={bodyId}>{tr(step.body)}</p>
            <ul className="intro-items">
              {step.items.map((item) => (
                <li key={item.label}>
                  <span className="intro-item-icon">{item.icon}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <span>{item.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="intro-foot">
            <div className="intro-dots" aria-hidden>
              {steps.map((s, i) => (
                <span key={s.title} className={i === index ? "is-on" : i < index ? "is-done" : undefined} />
              ))}
            </div>
            <div className="intro-buttons">
              {!last && (
                <button type="button" className="intro-skip" onClick={onClose}>
                  {tr("introSkip")}
                </button>
              )}
              {index > 0 && (
                <button type="button" className="room-glass-btn" onClick={() => setIndex((i) => i - 1)}>
                  {tr("prev")}
                </button>
              )}
              <button
                ref={nextRef}
                type="button"
                className="room-speak-btn intro-next"
                onClick={() => (last ? onClose() : setIndex((i) => i + 1))}
              >
                {last ? tr("landingStart") : tr("next")}
                <ArrowIcon />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* Pictures of each area, drawn with the app's own shapes and labels. */

function WelcomeVisual({ labels }: { labels: string[] }) {
  return (
    <div className="intro-mock intro-mock-welcome">
      <span className="intro-mock-ring" />
      <span className="intro-mock-logo">
        <SayloMark />
        SAYLO
      </span>
      <ol>
        {labels.map((label, i) => (
          <li key={label}>
            <span>{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
    </div>
  );
}

function AddVisual({ label }: { label: string }) {
  return (
    <div className="intro-mock intro-mock-grid">
      <div className="intro-mock-add intro-focus">
        <span>
          <PlusIcon />
        </span>
        {label}
      </div>
      <div className="intro-mock-pitch">
        <span style={{ background: "linear-gradient(135deg, #3bb5e8, #5b8cff)" }} />
        <i />
      </div>
      <div className="intro-mock-pitch">
        <span style={{ background: "linear-gradient(135deg, #2f7d6b, #3aa58a)" }} />
        <i />
      </div>
      <div className="intro-mock-pitch">
        <span style={{ background: "linear-gradient(135deg, #8a5a2b, #b87a38)" }} />
        <i />
      </div>
    </div>
  );
}

function SideVisual({ title, rename, remove }: { title: string; rename: string; remove: string }) {
  return (
    <div className="intro-mock intro-mock-side">
      <span className="intro-mock-logo">
        <SayloMark />
        SAYLO
      </span>
      <div className="intro-mock-side-head">
        <FolderIcon />
        {title}
        <b>4</b>
      </div>
      <ul>
        <li className="is-on intro-focus">
          <i />
          Coach
          <span className="intro-mock-more">
            <MoreIcon />
          </span>
        </li>
        <li>
          <i />
          Агаар
        </li>
        <li>
          <i />
          Уншаач
        </li>
        <li>
          <i />
          Автобус
        </li>
      </ul>
      <div className="intro-mock-menu">
        <span>{rename}</span>
        <span className="is-danger">{remove}</span>
      </div>
    </div>
  );
}

function SlideVisual({ speak, camera, full, prev, next }: { speak: string; camera: string; full: string; prev: string; next: string }) {
  return (
    <div className="intro-mock intro-mock-slide">
      <div className="intro-mock-screen">
        <span className="intro-mock-full">
          <ExpandIcon />
          {full}
        </span>
        <strong>Pitch Coach</strong>
        <div className="intro-mock-speak">
          <span className="intro-mock-speak-btn intro-focus">
            <MicIcon />
            {speak}
          </span>
          <span className="intro-mock-glass">
            <CameraIcon />
            {camera}
          </span>
        </div>
      </div>
      <div className="intro-mock-pager">
        <span>‹ {prev}</span>
        <b>2 / 12</b>
        <span>{next} ›</span>
      </div>
    </div>
  );
}

function SpeechVisual({ title, saved, analyze, result }: { title: string; saved: string; analyze: string; result: string }) {
  return (
    <div className="intro-mock intro-mock-speech">
      <div className="intro-mock-speech-head">
        <b>2</b>
        {title}
        <span>{saved}</span>
      </div>
      <div className="intro-mock-lines">
        <i style={{ width: "92%" }} />
        <i style={{ width: "78%" }} />
        <i style={{ width: "86%" }} />
        <i style={{ width: "54%" }} />
      </div>
      <span className="intro-mock-analyze intro-focus">
        <SparkIcon />
        {analyze}
      </span>
      <span className="intro-mock-result">{result} ›</span>
    </div>
  );
}

function AccountVisual({ intro, admin, logout }: { intro: string; admin: string; logout: string }) {
  return (
    <div className="intro-mock intro-mock-account">
      <div className="intro-mock-bar">
        <span className="intro-mock-pill intro-focus">
          <b>D</b>
          demo
          <ChevronIcon />
        </span>
      </div>
      <div className="intro-mock-panel">
        <span className="is-on">
          <BookIcon />
          {intro}
        </span>
        <span>
          <ShieldIcon />
          {admin}
        </span>
        <span>
          {logout}
          <ChevronIcon right />
        </span>
      </div>
    </div>
  );
}

function Num({ n }: { n: number }) {
  return <span className="intro-num">{n}</span>;
}

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

const PlusIcon = () => <Svg><path d="M8 3v10M3 8h10" /></Svg>;
const LinkIcon = () => <Svg><path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.9.9M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8A3 3 0 0 0 7.2 13l.9-.9" /></Svg>;
const CardIcon = () => <Svg><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M2 9.5h12" /></Svg>;
const FolderIcon = () => <Svg><path d="M2.2 4.8h3.6l1.1-1.3h6.9v8.9H2.2V4.8Z" /></Svg>;
const MoreIcon = () => <Svg><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.4" /></Svg>;
const MicIcon = () => <Svg><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" /><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" /></Svg>;
const CameraIcon = () => <Svg><rect x="1.5" y="4" width="9" height="8" rx="2" /><path d="m10.5 7 4-2.2v6.4l-4-2.2" /></Svg>;
const ExpandIcon = () => <Svg><path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" /></Svg>;
const ArrowsIcon = () => <Svg><path d="M6 4 2 8l4 4M10 4l4 4-4 4" /></Svg>;
const TextIcon = () => <Svg><path d="M3 4h10M3 7h10M3 10h7M3 13h4" /></Svg>;
const RedoIcon = () => <Svg><path d="M13 3v3.5H9.5M12.6 6.4A5 5 0 1 0 13 10" /></Svg>;
const SparkIcon = () => <Svg><path d="M8 1.5 9.4 6.6 14.5 8l-5.1 1.4L8 14.5 6.6 9.4 1.5 8l5.1-1.4L8 1.5Z" /></Svg>;
const PlayIcon = () => <Svg><path d="M5 3.5v9l7-4.5-7-4.5Z" /></Svg>;
const UserIcon = () => <Svg><circle cx="8" cy="5.5" r="2.8" /><path d="M2.8 14a5.2 5.2 0 0 1 10.4 0" /></Svg>;
const BookIcon = () => <Svg><path d="M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 0-1.5-1.5h-4v-8ZM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5h4v-8Z" /></Svg>;
const ExitIcon = () => <Svg><path d="M6 2.5H3v11h3M10.5 5l3 3-3 3M13.5 8H6.5" /></Svg>;
const ShieldIcon = () => <Svg><path d="M8 1.7 13.5 3.8v4.1c0 3.5-2.3 5.8-5.5 7.4C4.8 13.7 2.5 11.4 2.5 7.9V3.8L8 1.7Z" /></Svg>;
const ArrowIcon = () => <Svg><path d="M3 8h9.5M8.5 4l4 4-4 4" /></Svg>;
const CloseIcon = () => <Svg><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
const ChevronIcon = ({ right = false }: { right?: boolean }) => <Svg size={14}><path d={right ? "M6 3.5 10.5 8 6 12.5" : "M4 6l4 4 4-4"} /></Svg>;
