import React, { useEffect, useState } from 'react';
import { themeContrastRatio } from './theme-contrast';

const pairs = [
  ...['primary', 'secondary', 'accent', 'neutral', 'info', 'success', 'warning', 'error'].map((key) => [key, `${key}-content`]),
  ...['base-100', 'base-200', 'base-300'].map((key) => [key, 'base-content']),
];

export default function ThemeContrast({ colors, mode }: { colors: Record<string, string>; mode: string }) {
  const values = JSON.stringify(colors);
  const [issues, setIssues] = useState<string[]>([]);
  useEffect(() => {
    const palette: Record<string, string> = JSON.parse(values);
    setIssues(pairs.flatMap(([background, foreground]) => {
      const ratio = themeContrastRatio(palette[foreground], palette[background]);
      if (ratio === null) return [`${foreground} on ${background}: could not measure; check on your page.`];
      return ratio < 4.5 ? [`${foreground} on ${background}: ${ratio.toFixed(2)}:1 (below 4.5:1).`] : [];
    }));
  }, [values]);
  return <section aria-label={`${mode} theme contrast`} className="rounded-lg border border-white/10 p-4 text-sm text-zinc-300">
    <h4 className="font-semibold">Text contrast · {mode}</h4>
    <p className="mt-2">Approximate sRGB checks of theme text/background pairs against the 4.5:1 target for normal text. Check opacity, images and interaction states on your page too. These checks do not block saving.</p>
    <div role="status" aria-live="polite" aria-atomic="true" className="mt-2">
      {issues.length ? <ul className="list-disc pl-4 space-y-1">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p>No low-contrast pairs found.</p>}
    </div>
  </section>;
}
