import type { ReactNode } from "react";

/** Shared page and card geometry for entry points outside the app shell. */
export function StandalonePage({
  tone,
  children,
}: {
  readonly tone: "plain" | "error";
  readonly children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      {tone === "error" ? (
        <div className="pointer-events-none absolute inset-0 opacity-80" aria-hidden>
          <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
          <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
        </div>
      ) : null}

      <section
        className={
          tone === "plain"
            ? "relative w-full max-w-lg rounded-2xl border bg-card"
            : "relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 shadow-2xl shadow-black/20 backdrop-blur-md"
        }
      >
        <div className="p-6 sm:p-8">{children}</div>
      </section>
    </div>
  );
}

/** Entry-page headings keep their typography and spacing together. */
export function StandalonePageHeader({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <>
      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {eyebrow}
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}
