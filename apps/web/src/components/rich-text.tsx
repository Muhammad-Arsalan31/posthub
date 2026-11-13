import { Input, Menu, Text } from '@mantine/core';
import { useDisclosure, useFileDialog } from '@mantine/hooks';
import { RichTextEditor } from '@mantine/tiptap';
import Image from '@tiptap/extension-image';
import { useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import { bodyToEditorHtml } from '../lib/body';
import { mediaUrl, type MediaItem } from '../lib/platforms';
import { MediaLibraryModal, useUploadMedia } from './media';
import classes from './rich-text.module.css';

export interface RichTextChange {
  /** HTML, or '' when the editor is empty. */
  html: string;
  text: string;
}

const isImageFile = (file: File) => file.type.startsWith('image/');

function insertImage(editor: Editor, item: MediaItem, at?: number) {
  const chain = editor.chain().focus();
  (at === undefined ? chain : chain.setTextSelection(at))
    .setImage({ src: mediaUrl(item.id), alt: item.fileName.replace(/\.[^.]+$/, '') })
    .run();
}

function ImageIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <rect x={3} y={4} width={18} height={16} rx={2} />
      <circle cx={8.5} cy={9.5} r={1.5} />
      <path d="m21 16-5-5-9 9" />
    </svg>
  );
}

/**
 * A WordPress-style editor for the post body. Images can be inserted from the toolbar, pasted or
 * dropped; they are uploaded to the media library and placed in the text.
 */
export function RichTextInput(props: {
  label: string;
  description?: string;
  initialValue: string;
  onChange: (value: RichTextChange) => void;
}) {
  const { upload, uploading } = useUploadMedia();
  const [libraryOpen, library] = useDisclosure(false);
  // Event handlers registered once at editor creation read the latest upload function from here.
  const uploadRef = useRef(upload);
  useEffect(() => {
    uploadRef.current = upload;
  });
  const editorRef = useRef<Editor | null>(null);

  async function uploadAndInsert(files: File[], at?: number) {
    const editor = editorRef.current;
    const images = files.filter(isImageFile);
    if (!editor || !images.length) return;
    const uploaded = await uploadRef.current(images);
    for (const item of uploaded.reverse()) insertImage(editor, item, at);
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        link: { openOnClick: false, defaultProtocol: 'https' },
      }),
      Image.configure({ inline: false, allowBase64: false }),
    ],
    content: bodyToEditorHtml(props.initialValue),
    editorProps: {
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter(isImageFile);
        if (!files.length) return false;
        void uploadAndInsert(files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = [...(event.dataTransfer?.files ?? [])].filter(isImageFile);
        if (moved || !files.length) return false;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void uploadAndInsert(files, at);
        return true;
      },
    },
    onUpdate: ({ editor }) =>
      props.onChange({
        html: editor.isEmpty ? '' : editor.getHTML(),
        text: editor.getText({ blockSeparator: '\n\n' }).trim(),
      }),
  });
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  const fileDialog = useFileDialog({
    accept: 'image/*',
    multiple: true,
    resetOnOpen: true,
    onChange: (files) => void uploadAndInsert([...(files ?? [])]),
  });

  return (
    <Input.Wrapper label={props.label} description={props.description}>
      <RichTextEditor editor={editor} mt={4} aria-label={props.label}>
        <RichTextEditor.Toolbar sticky stickyOffset={56}>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Bold />
            <RichTextEditor.Italic />
            <RichTextEditor.Underline />
            <RichTextEditor.Strikethrough />
            <RichTextEditor.ClearFormatting />
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.H2 />
            <RichTextEditor.H3 />
            <RichTextEditor.H4 />
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.BulletList />
            <RichTextEditor.OrderedList />
            <RichTextEditor.Blockquote />
            <RichTextEditor.Hr />
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Link />
            <RichTextEditor.Unlink />
            <Menu position="bottom-start" withinPortal>
              <Menu.Target>
                <RichTextEditor.Control
                  aria-label="Insert image"
                  title="Insert image"
                  disabled={uploading > 0}
                >
                  <ImageIcon />
                </RichTextEditor.Control>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={fileDialog.open}>Upload image…</Menu.Item>
                <Menu.Item onClick={library.open}>From media library</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Undo />
            <RichTextEditor.Redo />
          </RichTextEditor.ControlsGroup>
        </RichTextEditor.Toolbar>
        <RichTextEditor.Content mih={220} className={classes.content} />
      </RichTextEditor>
      <Text size="xs" c="dimmed" mt={4}>
        {uploading > 0
          ? 'Uploading image…'
          : 'Paste or drop images to place them in the text. WordPress keeps the formatting and images; other platforms get the plain text and the media attached below.'}
      </Text>
      <MediaLibraryModal
        opened={libraryOpen}
        onClose={library.close}
        selected={[]}
        filter={(item) => item.mimeType.startsWith('image/')}
        onToggle={(item) => {
          if (editor) insertImage(editor, item);
          library.close();
        }}
      />
    </Input.Wrapper>
  );
}
