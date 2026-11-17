import React, { useEffect, useRef, useState } from "react";
import { currencyMinorUnits, fromMinorUnits } from "../money";
import { storeCurrency } from "./currency";
/** Display major units while keeping the existing minor-unit draft and API contract. */
export default function ProductPriceInput({
  value,
  onChange,
  ...props
}: {
  value: string;
  onChange: (value: string) => void;
  id: string;
  placeholder?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const currency = storeCurrency(),
    digits = currencyMinorUnits(currency),
    scale = 10 ** digits;
  const display = (v: string) =>
    v === ""
      ? ""
      : Number.isFinite(Number(v))
        ? String(fromMinorUnits(Number(v), currency))
        : v;
  const [text, setText] = useState(() => display(value));
  const sent = useRef(value);
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(display(value));
    }
  }, [value]);
  return (
    <input
      {...props}
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const valid = new RegExp(`^\\d+(?:\\.\\d{0,${digits}})?$`).test(
          raw.trim(),
        );
        const next =
          raw.trim() === ""
            ? ""
            : valid
              ? String(Math.round(Number(raw) * scale))
              : "invalid";
        sent.current = next;
        onChange(next);
      }}
    />
  );
}
