import React from "react";
import { MediaFieldInput } from "../MediaFieldInput";
import { Button } from "../ui/button";

/** Preserve the collection's [{url}] shape while presenting a visual, ordered gallery. */
export function ImageGalleryField({
  value,
  onChange,
  basePath,
  disabled,
}: {
  value: Array<{ url: string }>;
  onChange: (value: Array<{ url: string }>) => void;
  basePath: string;
  disabled: boolean;
}) {
  const move = (index: number, to: number) => {
    const next = [...value];
    const [image] = next.splice(index, 1);
    next.splice(to, 0, image);
    onChange(next);
  };
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-400">
        The first image is your main product image. Reorder the gallery or
        choose a different cover.
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {value.map((image, index) => (
          <div
            key={`${image.url}-${index}`}
            className="rounded-xl border border-white/10 overflow-hidden bg-black/20"
          >
            <div className="aspect-square relative">
              <img
                src={image.url}
                alt={`Product image ${index + 1}`}
                className="w-full h-full object-cover"
              />
              {index === 0 && (
                <span className="absolute top-2 left-2 rounded bg-black/80 px-2 py-1 text-xs text-white">
                  Main image
                </span>
              )}
            </div>
            <div className="p-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || index === 0}
                aria-label={`Make image ${index + 1} the main image`}
                onClick={() => move(index, 0)}
              >
                Make main
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || index === 0}
                aria-label={`Move image ${index + 1} earlier`}
                onClick={() => move(index, index - 1)}
              >
                ←
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || index === value.length - 1}
                aria-label={`Move image ${index + 1} later`}
                onClick={() => move(index, index + 1)}
              >
                →
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={`Remove product image ${index + 1}`}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>
      <MediaFieldInput
        pickerOnly
        adminBasePath={basePath}
        label="Add product image"
        value=""
        onChange={(url) => {
          if (url && !disabled && !value.some((image) => image.url === url))
            onChange([...value, { url }]);
        }}
        placeholder="Choose or upload an image"
      />
    </div>
  );
}
