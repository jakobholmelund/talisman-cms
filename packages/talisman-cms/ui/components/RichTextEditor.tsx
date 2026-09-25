import React, { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Button } from './ui/button';
import { Bold, Italic, Strikethrough, Heading1, Heading2, List, ListOrdered, Quote } from 'lucide-react';

export interface RichTextEditorProps {
  value?: any;
  onChange?: (value: any) => void;
  className?: string;
  hasError?: boolean;
}

const MenuBar = ({ editor }: { editor: any }) => {
  if (!editor) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1 p-2 border-b border-white/10 bg-white/[0.02] rounded-t-lg shadow-sm">
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
        className={editor.isActive('bold') ? 'bg-zinc-800 text-white' : 'text-zinc-400'}
        type="button"
      >
        <Bold size={16} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
        className={editor.isActive('italic') ? 'bg-zinc-800 text-white' : 'text-zinc-400'}
        type="button"
      >
        <Italic size={16} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => { e.preventDefault(); editor.chain().focus().toggleStrike().run(); }}
        className={editor.isActive('strike') ? 'bg-zinc-800 text-white' : 'text-zinc-400'}
        type="button"
      >
        <Strikethrough size={16} />
      </Button>
      
      <div className="w-[1px] bg-zinc-800 mx-1" />
      
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 1 }).run(); }}
        className={editor.isActive('heading', { level: 1 }) ? 'bg-indigo-500/20 text-indigo-300' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-300'}
        type="button"
      >
        <Heading1 size={16} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 2 }).run(); }}
        className={editor.isActive('heading', { level: 2 }) ? 'bg-indigo-500/20 text-indigo-300' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-300'}
        type="button"
      >
        <Heading2 size={16} />
      </Button>
      
      <div className="w-[1px] bg-zinc-800 mx-1" />

      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => { e.preventDefault(); editor.chain().focus().toggleBulletList().run(); }}
        className={editor.isActive('bulletList') ? 'bg-zinc-800 text-white' : 'text-zinc-400'}
        type="button"
      >
        <List size={16} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => { e.preventDefault(); editor.chain().focus().toggleOrderedList().run(); }}
        className={editor.isActive('orderedList') ? 'bg-zinc-800 text-white' : 'text-zinc-400'}
        type="button"
      >
        <ListOrdered size={16} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => { e.preventDefault(); editor.chain().focus().toggleBlockquote().run(); }}
        className={editor.isActive('blockquote') ? 'bg-indigo-500/20 text-indigo-300' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-300'}
        type="button"
      >
        <Quote size={16} />
      </Button>
    </div>
  );
};

export function RichTextEditor({ value, onChange, className = '', hasError }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: value || { type: 'doc', content: [] },
    editorProps: {
      attributes: {
        class: 'prose prose-invert prose-sm sm:prose-base focus:outline-none min-h-[150px] p-4 max-w-none',
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

  return (
    <div className={`border rounded-lg bg-zinc-950/50 flex flex-col shadow-inner transition-all duration-200 ${hasError ? 'border-red-500/50 hover:border-red-500 focus-within:ring-2 focus-within:ring-red-500/50' : 'border-white/10 hover:border-white/20 focus-within:ring-2 focus-within:ring-indigo-500/50 focus-within:border-indigo-500/50'} ${className}`}>
      <MenuBar editor={editor} />
      <EditorContent editor={editor} className="flex-1 overflow-y-auto" />
    </div>
  );
}
