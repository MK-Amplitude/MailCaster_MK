import { useEffect, useState } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TextAlign from '@tiptap/extension-text-align'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import { ResizableImage } from './ResizableImage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Bold,
  Italic,
  Strikethrough,
  UnderlineIcon,
  Link2,
  Link2Off,
  Image as ImageIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  List,
  ListOrdered,
  Quote,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Pilcrow,
  Minus,
  Eraser,
  Undo,
  Redo,
  Palette,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TipTapEditorProps {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  className?: string
}

// 글자 색상 팔레트 — 8×6 = 48색.
// 순수 흑백 계조 + 기본 12색(채도 3단계 × 명도 4단계)로 구성.
// 제일 아래 두 줄은 어두운 톤 — 이메일에서 가독성 높은 레벨.
const COLOR_PALETTE: string[] = [
  // row 0 : 흑백 계조
  '#000000', '#424242', '#636363', '#9C9C94', '#CEC6CE', '#EFEFEF', '#F5F5F5', '#FFFFFF',
  // row 1 : 비비드
  '#FF0000', '#FF9C00', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#9C00FF', '#FF00FF',
  // row 2 : 페일 (배경에 가까움)
  '#F7C6CE', '#FFE7CE', '#FFEFC6', '#D6EFD6', '#CEDEE7', '#CEE7F7', '#D6D6E7', '#E7D6DE',
  // row 3 : 미드톤
  '#E76363', '#F7AD6B', '#FFD663', '#94BD7B', '#73A5AD', '#6BADDE', '#8C7BC6', '#C67BA5',
  // row 4 : 딥
  '#CE0000', '#E79439', '#EFC631', '#6BA54A', '#4A7B8C', '#3984C6', '#634AA5', '#A54A7B',
  // row 5 : 다크
  '#9C0000', '#B56308', '#BD9400', '#397B21', '#104A5A', '#085294', '#311873', '#731842',
]

/**
 * 풀 기능 rich-text 에디터.
 *
 * 이전 구현 대비 추가된 것:
 *   - 실행 취소 / 다시
 *   - Heading 1~3 / 본문 토글
 *   - 취소선
 *   - 글자 색상 팔레트(+ 사용자 지정 + 해제)
 *   - 글머리/번호 리스트, 인용, 코드 블록
 *   - 양쪽 맞춤 정렬
 *   - 링크 수정 UX — 기존 링크 URL 자동 채움 + 제거 버튼
 *   - 이미지 삽입 팝오버 (window.prompt 제거)
 *   - 가로 구분선
 *   - 서식 지우기
 *
 * HTML 출력 호환성:
 *   - 모든 포맷은 표준 HTML 태그 + 인라인 style (color, text-align).
 *   - 이메일 클라이언트(Gmail 포함)에서 렌더링 문제 없음.
 *   - HTML 탭과 비주얼 탭 간 전환 시 왕복 변환이 깔끔하도록 StarterKit 기본값 유지.
 */
function TipTapEditor({ value, onChange, placeholder, className }: TipTapEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: {
          // 이메일 링크는 새 창/앱에서 열리는 게 기대 동작.
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        },
      }),
      ResizableImage.configure({
        inline: false,
        allowBase64: true,
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
      // Placeholder 확장 — 빈 paragraph 에 `is-editor-empty` 클래스와
      // `data-placeholder` attribute 를 자동으로 붙여준다. 이것 없이는
      // CSS 의 `p.is-editor-empty::before { content: attr(data-placeholder) }`
      // 규칙이 타겟을 못 찾아 placeholder 가 표시되지 않는다.
      Placeholder.configure({
        placeholder: placeholder ?? '내용을 입력하세요...',
        // 문서 전체가 비었을 때만 표시 (중간 빈 문단에는 X)
        showOnlyWhenEditable: true,
        showOnlyCurrent: false,
      }),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML())
    },
  })

  // 외부 value prop 이 변할 때 에디터 내용 동기화 (HTML 탭 편집, 수정 모드 진입 등)
  // 루프 방지: 현재 HTML 과 다를 때만 setContent.
  useEffect(() => {
    if (!editor) return
    if (editor.getHTML() === value) return
    editor.commands.setContent(value || '', false)
  }, [value, editor])

  if (!editor) return null

  return (
    <div className={cn('border rounded-lg overflow-hidden tiptap-editor', className)}>
      <EditorToolbar editor={editor} />
      <EditorContent
        editor={editor}
        className="min-h-[160px] max-h-[400px] overflow-y-auto text-sm"
      />
    </div>
  )
}

export default TipTapEditor

// ------------------------------------------------------------
// 툴바 — 에디터 인스턴스를 받아 각 명령을 바인딩한다.
// 버튼 활성 상태는 editor.isActive(...) 로 매 렌더 계산 — 커서 이동 시 갱신.
// ------------------------------------------------------------
function EditorToolbar({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [imageOpen, setImageOpen] = useState(false)
  const [imageUrl, setImageUrl] = useState('')

  // 링크 팝오버가 열릴 때 기존 링크 URL 을 미리 채운다 — 편집 UX.
  const handleLinkOpenChange = (open: boolean) => {
    setLinkOpen(open)
    if (open) {
      const existing = editor.getAttributes('link').href as string | undefined
      setLinkUrl(existing ?? '')
    }
  }

  const applyLink = () => {
    const raw = linkUrl.trim()
    if (!raw) return
    // 사용자가 스킴을 생략하면 https:// 로 보정. mailto:/tel: 는 그대로 허용.
    const normalized = /^(https?:|mailto:|tel:)/i.test(raw) ? raw : `https://${raw}`

    if (editor.isActive('link')) {
      // 기존 링크 수정
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .setLink({ href: normalized })
        .run()
    } else {
      const { from, to } = editor.state.selection
      if (from === to) {
        // 선택 영역 없음 → URL 자체를 클릭 가능한 텍스트로 삽입
        editor
          .chain()
          .focus()
          .insertContent([
            {
              type: 'text',
              text: normalized,
              marks: [{ type: 'link', attrs: { href: normalized } }],
            },
          ])
          .run()
      } else {
        // 선택 영역 있음 → 그 영역을 링크로 감싸기
        editor.chain().focus().setLink({ href: normalized }).run()
      }
    }
    setLinkOpen(false)
    setLinkUrl('')
  }

  const removeLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    setLinkOpen(false)
    setLinkUrl('')
  }

  const handleImageOpenChange = (open: boolean) => {
    setImageOpen(open)
    if (!open) setImageUrl('')
  }

  const applyImage = () => {
    const raw = imageUrl.trim()
    if (!raw) return
    editor.chain().focus().setImage({ src: raw }).run()
    setImageOpen(false)
    setImageUrl('')
  }

  // 현재 커서 위치의 글자 색 (팔레트 트리거에 미니 프리뷰로 표시)
  const currentColor = (editor.getAttributes('textStyle').color as string | undefined) ?? ''

  return (
    <div className="flex items-center gap-0.5 px-1.5 py-1 border-b bg-muted/30 flex-wrap">
      {/* --- 실행 취소 / 다시 --- */}
      <TB
        onClick={() => editor.chain().focus().undo().run()}
        title="실행 취소"
        disabled={!editor.can().chain().focus().undo().run()}
      >
        <Undo className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().redo().run()}
        title="다시 실행"
        disabled={!editor.can().chain().focus().redo().run()}
      >
        <Redo className="w-3.5 h-3.5" />
      </TB>
      <Divider />

      {/* --- 문단 스타일 --- */}
      <TB
        onClick={() => editor.chain().focus().setParagraph().run()}
        active={editor.isActive('paragraph') && !editor.isActive('heading')}
        title="본문"
      >
        <Pilcrow className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive('heading', { level: 1 })}
        title="제목 1"
      >
        <Heading1 className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive('heading', { level: 2 })}
        title="제목 2"
      >
        <Heading2 className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive('heading', { level: 3 })}
        title="제목 3"
      >
        <Heading3 className="w-3.5 h-3.5" />
      </TB>
      <Divider />

      {/* --- 인라인 포맷 --- */}
      <TB
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
        title="굵게"
      >
        <Bold className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
        title="기울임"
      >
        <Italic className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive('underline')}
        title="밑줄"
      >
        <UnderlineIcon className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive('strike')}
        title="취소선"
      >
        <Strikethrough className="w-3.5 h-3.5" />
      </TB>

      {/* --- 글자 색상 --- */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 relative"
            title="글자 색상"
          >
            <Palette className="w-3.5 h-3.5" />
            {/* 현재 색상 프리뷰 - 아이콘 우하단에 작게 */}
            <span
              className="absolute bottom-0.5 right-0.5 w-2 h-1 rounded-sm border border-background"
              style={{ background: currentColor || 'transparent' }}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2" align="start">
          <div className="grid grid-cols-8 gap-1">
            {COLOR_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`색상 ${c}`}
                className={cn(
                  'w-5 h-5 rounded border border-border transition-transform hover:scale-110 focus:scale-110 focus:outline-none focus:ring-2 focus:ring-ring',
                  currentColor.toLowerCase() === c.toLowerCase() && 'ring-2 ring-primary',
                )}
                style={{ background: c }}
                onClick={() => editor.chain().focus().setColor(c).run()}
              />
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2 pt-2 border-t">
            <label className="flex items-center gap-1 text-xs cursor-pointer">
              <input
                type="color"
                className="w-7 h-7 rounded border-0 cursor-pointer bg-transparent p-0"
                value={currentColor || '#000000'}
                onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
              />
              <span className="text-muted-foreground">사용자 지정</span>
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto h-7 text-xs"
              onClick={() => editor.chain().focus().unsetColor().run()}
            >
              해제
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <Divider />

      {/* --- 리스트 / 인용 / 코드 --- */}
      <TB
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive('bulletList')}
        title="글머리 기호"
      >
        <List className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive('orderedList')}
        title="번호 매기기"
      >
        <ListOrdered className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive('blockquote')}
        title="인용"
      >
        <Quote className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive('codeBlock')}
        title="코드 블록"
      >
        <Code className="w-3.5 h-3.5" />
      </TB>
      <Divider />

      {/* --- 정렬 --- */}
      <TB
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        active={editor.isActive({ textAlign: 'left' })}
        title="왼쪽 정렬"
      >
        <AlignLeft className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        active={editor.isActive({ textAlign: 'center' })}
        title="가운데 정렬"
      >
        <AlignCenter className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        active={editor.isActive({ textAlign: 'right' })}
        title="오른쪽 정렬"
      >
        <AlignRight className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().setTextAlign('justify').run()}
        active={editor.isActive({ textAlign: 'justify' })}
        title="양쪽 맞춤"
      >
        <AlignJustify className="w-3.5 h-3.5" />
      </TB>
      <Divider />

      {/* --- 링크 --- */}
      <Popover open={linkOpen} onOpenChange={handleLinkOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('h-7 w-7', editor.isActive('link') && 'bg-accent')}
            title={editor.isActive('link') ? '링크 수정' : '링크 삽입'}
          >
            <Link2 className="w-3.5 h-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3" align="start">
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              {editor.isActive('link') ? '링크 수정' : '링크 삽입'}
            </div>
            <Input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  applyLink()
                }
                if (e.key === 'Escape') {
                  setLinkOpen(false)
                }
              }}
              placeholder="https://example.com"
              className="h-8 text-sm"
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="h-7 text-xs flex-1"
                onClick={applyLink}
                disabled={!linkUrl.trim()}
              >
                {editor.isActive('link') ? '수정' : '삽입'}
              </Button>
              {editor.isActive('link') && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={removeLink}
                >
                  <Link2Off className="w-3 h-3 mr-1" />
                  제거
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              선택 영역이 없으면 URL 자체가 링크로 삽입됩니다. 스킴을 생략하면 https:// 가
              자동으로 붙습니다.
            </p>
          </div>
        </PopoverContent>
      </Popover>

      {/* --- 이미지 --- */}
      <Popover open={imageOpen} onOpenChange={handleImageOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="이미지 삽입"
          >
            <ImageIcon className="w-3.5 h-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3" align="start">
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">이미지 URL</div>
            <Input
              autoFocus
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  applyImage()
                }
                if (e.key === 'Escape') {
                  setImageOpen(false)
                }
              }}
              placeholder="https://example.com/image.png"
              className="h-8 text-sm"
            />
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs w-full"
              onClick={applyImage}
              disabled={!imageUrl.trim()}
            >
              삽입
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <Divider />

      {/* --- 구분선 / 서식 지우기 --- */}
      <TB
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="가로 구분선"
      >
        <Minus className="w-3.5 h-3.5" />
      </TB>
      <TB
        onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
        title="서식 지우기"
      >
        <Eraser className="w-3.5 h-3.5" />
      </TB>
    </div>
  )
}

// ------------------------------------------------------------
// 작은 내부 프리미티브 — 툴바 버튼과 구분선
// ------------------------------------------------------------
function TB({
  onClick,
  active,
  children,
  title,
  disabled,
}: {
  onClick: () => void
  active?: boolean
  children: React.ReactNode
  title?: string
  disabled?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('h-7 w-7', active && 'bg-accent')}
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </Button>
  )
}

function Divider() {
  return <div className="w-px h-4 bg-border mx-0.5 self-center" />
}
