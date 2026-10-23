export const inputClass = "ui-input";

export function Field({
  label,
  hint,
  className = "",
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block space-y-1 ${className}`}>
      <span className="ui-muted">{label}</span>
      {children}
      {hint && <span className="ui-help block">{hint}</span>}
    </label>
  );
}

export function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="ui-card">
      <h2 className="ui-section">{title}</h2>
      {hint && <p className="ui-help mt-0.5">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
