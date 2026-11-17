import React, { useEffect, useRef } from "react";

/** Follow the name only while the handle is automatic; never overwrite an existing/custom handle. */
export function AutoSlugInput({
  source,
  value,
  onChange,
  ...props
}: {
  source: unknown;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  onBlur: () => void;
}) {
  const automatic = useRef(!value);
  useEffect(() => {
    if (!automatic.current) return;
    const next = String(source || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 180);
    if (next !== value) onChange(next);
  }, [source]);
  return (
    <input
      {...props}
      value={value}
      onChange={(event) => {
        automatic.current = false;
        onChange(event.target.value);
      }}
      className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm"
    />
  );
}
