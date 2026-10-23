/** The Saylo microphone mark used in the top bar. Inherits its color from the text. */
export default function SayloMark() {
  return (
    <svg width="22" height="24" viewBox="0 0 26 28" aria-hidden>
      <rect x="8" y="1" width="8" height="15" rx="4" fill="currentColor" />
      <path
        d="M4 11.5v.5a8 8 0 0 0 16 0v-.5M12 20v4.5M8 25.5h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M19.5 3.5 24 6.5l-4.5 3z" fill="#6c63ff" stroke="#6c63ff" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}
