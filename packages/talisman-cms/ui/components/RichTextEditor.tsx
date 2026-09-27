import React, { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Button } from './ui/button';
import { Bold, Italic, Strikethrough, Heading1, Heading2, List, ListOrdered, Quote } from 'lucide-react';

export interface RichTextEditorProps {
  value?: any;
  onChange?: (value: any) => void;
  className?: string;
  hasError?: boolean;
  /** The id of the visible label that names the editor. */
  ariaLabelledBy?: string;
  /** The id of an error or help text that describes the editor. */
  ariaDescribedBy?: string;
  /** Marks the text box as required for assistive technology. */
  required?: boolean;
}

type ToolbarAction = {
  label: string;
  icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  isActive: (editor: any) => boolean;
  run: (editor: any) => void;
  activeClassName: string;
  inactiveClassName: string;
};

const PLAIN_ACTIVE = 'bg-zinc-800 text-white';
const PLAIN_INACTIVE = 'text-zinc-400';
const ACCENT_ACTIVE = 'bg-indigo-500/20 text-indigo-300';
const ACCENT_INACTIVE = 'text-zinc-400 hover:bg-white/5 hover:text-zinc-300';

// Icon-only buttons, so each one carries its name and whether it is switched on.
const TOOLBAR_GROUPS: ToolbarAction[][] = [
  [
    { label: 'Bold', icon: Bold, isActive: (editor) => editor.isActive('bold'), run: (editor) => editor.chain().focus().toggleBold().run(), activeClassName: PLAIN_ACTIVE, inactiveClassName: PLAIN_INACTIVE },
    { label: 'Italic', icon: Italic, isActive: (editor) => editor.isActive('italic'), run: (editor) => editor.chain().focus().toggleItalic().run(), activeClassName: PLAIN_ACTIVE, inactiveClassName: PLAIN_INACTIVE },
    { label: 'Strikethrough', icon: Strikethrough, isActive: (editor) => editor.isActive('strike'), run: (editor) => editor.chain().focus().toggleStrike().run(), activeClassName: PLAIN_ACTIVE, inactiveClassName: PLAIN_INACTIVE },
  ],
  [
    { label: 'Heading 1', icon: Heading1, isActive: (editor) => editor.isActive('heading', { level: 1 }), run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(), activeClassName: ACCENT_ACTIVE, inactiveClassName: ACCENT_INACTIVE },
    { label: 'Heading 2', icon: Heading2, isActive: (editor) => editor.isActive('heading', { level: 2 }), run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(), activeClassName: ACCENT_ACTIVE, inactiveClassName: ACCENT_INACTIVE },
  ],
  [
    { label: 'Bulleted list', icon: List, isActive: (editor) => editor.isActive('bulletList'), run: (editor) => editor.chain().focus().toggleBulletList().run(), activeClassName: PLAIN_ACTIVE, inactiveClassName: PLAIN_INACTIVE },
    { label: 'Numbered list', icon: ListOrdered, isActive: (editor) => editor.isActive('orderedList'), run: (editor) => editor.chain().focus().toggleOrderedList().run(), activeClassName: PLAIN_ACTIVE, inactiveClassName: PLAIN_INACTIVE },
    { label: 'Quote', icon: Quote, isActive: (editor) => editor.isActive('blockquote'), run: (editor) => editor.chain().focus().toggleBlockquote().run(), activeClassName: ACCENT_ACTIVE, inactiveClassName: ACCENT_INACTIVE },
  ],
];

const TOOLBAR_ACTIONS = TOOLBAR_GROUPS.flat();

const MenuBar = ({ editor, ariaLabelledBy }: { editor: any; ariaLabelledBy?: string }) => {
  // One tab stop: the arrow keys, Home and End move between the buttons, as in the ARIA toolbar pattern.
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!editor) {
    return null;
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const targets: Record<string, number> = { ArrowRight: activeIndex + 1, ArrowLeft: activeIndex - 1, Home: 0, End: TOOLBAR_ACTIONS.length - 1 };
    if (!(event.key in targets)) return;
    event.preventDefault();
    const next = (targets[event.key] + TOOLBAR_ACTIONS.length) % TOOLBAR_ACTIONS.length;
    setActiveIndex(next);
    buttonRefs.current[next]?.focus();
  };

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      aria-describedby={ariaLabelledBy}
      onKeyDown={handleKeyDown}
      className="flex flex-wrap gap-1 p-2 border-b border-white/10 bg-white/[0.02] rounded-t-lg shadow-sm"
    >
      {TOOLBAR_GROUPS.map((group, groupIndex) => (
        <React.Fragment key={group[0].label}>
          {groupIndex > 0 && <div aria-hidden="true" className="w-[1px] bg-zinc-800 mx-1" />}
          {group.map((action) => {
            const active = action.isActive(editor);
            const Icon = action.icon;
            const index = TOOLBAR_ACTIONS.indexOf(action);
            return (
              <Button
                key={action.label}
                ref={(element) => { buttonRefs.current[index] = element; }}
                variant="ghost"
                size="sm"
                type="button"
                tabIndex={index === activeIndex ? 0 : -1}
                onFocus={() => setActiveIndex(index)}
                aria-label={action.label}
                aria-pressed={active}
                title={action.label}
                onClick={(e) => { e.preventDefault(); action.run(editor); }}
                className={active ? action.activeClassName : action.inactiveClassName}
              >
                <Icon size={16} aria-hidden="true" />
              </Button>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
};

export function RichTextEditor({ value, onChange, className = '', hasError, ariaLabelledBy, ariaDescribedBy, required }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: value || { type: 'doc', content: [] },
    editorProps: {
      attributes: {
        class: 'prose prose-invert prose-sm sm:prose-base focus:outline-none min-h-[150px] p-4 max-w-none',
        // The editable area is a multi-line text box named by the field's label.
        role: 'textbox',
        'aria-multiline': 'true',
        ...(ariaLabelledBy ? { 'aria-labelledby': ariaLabelledBy } : {}),
        ...(required ? { 'aria-required': 'true' } : {}),
      },
    },
    onUpdate: ({ editor, transaction }) => {
      // Only report the user's own document changes. Plugins such as StarterKit's TrailingNode append
      // doc-changing transactions to a mere click or focus, which would otherwise count as an edit.
      if (!transaction.docChanged) return;
      // Export JSON content
      const json = editor.getJSON();
      onChange?.(json);
    },
  });

  // Sync value if changed externally (e.g. form reset from raw JSON mode or loading the latest version).
  // The sync never emits an update: Tiptap normalises the JSON it loads, and echoing that back through
  // onChange would mark rich text the user did not touch as edited.
  useEffect(() => {
    if (!editor) return;
    if (!value) {
      if (!editor.isEmpty) queueMicrotask(() => editor.commands.clearContent(false));
      return;
    }
    const currentJson = editor.getJSON();
    // A naive deep equality check for syncing
    if (JSON.stringify(currentJson) !== JSON.stringify(value)) {
      queueMicrotask(() => {
        editor.commands.setContent(value, { emitUpdate: false });
      });
    }
  }, [value, editor]);

  // The error state changes after the editor is created (for example when a server error arrives), so
  // these attributes are kept on the editable element here rather than in the editor's options.
  useEffect(() => {
    if (!editor) return;
    let element: HTMLElement | undefined;
    try {
      element = editor.view.dom as HTMLElement;
    } catch {
      // Not mounted yet (EditorContent mounts it before this effect runs, so this is only a guard).
      return;
    }
    if (!element) return;
    const setAttribute = (name: string, next: string | undefined) => {
      if (next) element.setAttribute(name, next);
      else element.removeAttribute(name);
    };
    setAttribute('aria-describedby', ariaDescribedBy);
    setAttribute('aria-invalid', hasError ? 'true' : undefined);
  }, [editor, ariaDescribedBy, hasError]);

  return (
    <div className={`border rounded-lg bg-zinc-950/50 flex flex-col shadow-inner transition-all duration-200 ${hasError ? 'border-red-500/50 hover:border-red-500 focus-within:ring-2 focus-within:ring-red-500/50' : 'border-white/10 hover:border-white/20 focus-within:ring-2 focus-within:ring-indigo-500/50 focus-within:border-indigo-500/50'} ${className}`}>
      <MenuBar editor={editor} ariaLabelledBy={ariaLabelledBy} />
      <EditorContent editor={editor} className="flex-1 overflow-y-auto" />
    </div>
  );
}
