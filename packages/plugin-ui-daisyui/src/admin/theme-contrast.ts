// Use the browser's CSS parser and sRGB canvas conversion, including modern colour functions.
// A transparent background needs page context, so it must not produce a misleading pass.
export function themeContrastRatio(foreground: string, background: string): number | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  const read = (value: string): number[] | null => {
    if (!CSS.supports('color', value) || /\b(?:currentcolor|inherit|initial|unset|revert|var|env|light-dark)\b/i.test(value)) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  };
  const fg = read(foreground);
  const bg = read(background);
  if (!fg || !bg || bg[3] !== 255) return null;
  const alpha = fg[3] / 255;
  const luminance = (rgb: number[]) => rgb.slice(0, 3).reduce((sum, channel, index) => {
    const value = channel / 255;
    return sum + [0.2126, 0.7152, 0.0722][index] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  }, 0);
  const front = luminance(fg.map((channel, index) => channel * alpha + bg[index] * (1 - alpha)));
  const back = luminance(bg);
  return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
}
