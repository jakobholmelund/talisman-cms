import React, { useEffect, useRef, useState } from "react";
/** Commerce prices stay integer minor units in the form and API, but merchants type normal prices. */
export function MoneyFieldInput({
  value,
  onChange,
  onBlur,
  ...props
}: {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  onBlur: () => void;
  id?: string;
}) {
  const currency =
    document
      .querySelector('meta[name="talisman-setting-commerce-currency"]')
      ?.getAttribute("content")
      ?.toUpperCase() || "USD";
  const scale = currency === "JPY" ? 1 : 100,
    digits = scale === 1 ? 0 : 2;
  const [text, setText] = useState(value == null ? "" : String(value / scale));
  const sent = useRef(value);
  useEffect(() => {
    if (!Object.is(value, sent.current)) {
      sent.current = value;
      setText(value == null ? "" : String(value / scale));
    }
  }, [value, scale]);
  return (
    <div className="relative">
      <input
        {...props}
        aria-label={`Price (${currency})`}
        inputMode="decimal"
        value={text}
        onBlur={onBlur}
        className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 pr-16 text-sm"
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const valid = new RegExp(`^\\d+(?:\\.\\d{0,${digits}})?$`).test(
            raw.trim(),
          );
          const next =
            raw.trim() === ""
              ? null
              : valid
                ? Math.round(Number(raw) * scale)
                : NaN;
          sent.current = next;
          onChange(next);
        }}
      />
      <span className="absolute right-3 top-3 text-xs text-zinc-400">
        {currency}
      </span>
    </div>
  );
}
