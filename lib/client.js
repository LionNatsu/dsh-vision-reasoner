/**
 * dsh-vision-reasoner (browser half).
 *
 * One job: make the pictures these tools draw visible where a person already
 * looks for them. A tool call in the transcript is a row; the row for a
 * `vision_show` shows the view it rendered, and clicking it opens that PNG in the
 * right sidebar — the same two things `read_image` does.
 *
 * Neither of those is a host-side field. The Web client derives its cards from
 * the wire (`dsh-client-ui-tool`): the call's arguments, the result's content
 * blocks, and the result's tool-private `meta`. Its built-in image card is gated
 * on the tool name being exactly `read_image`, and its click-to-preview link
 * comes from a name→variant table that does not know these four names — so a
 * third-party tool gets its own row by registering one in the Tool-owned keyed
 * slot, which is what this half does.
 *
 * The slot key IS the wire tool name, and it dispatches by it.
 *
 * Two things this half deliberately does NOT do:
 *
 * - It does not declare `tool.call.images` as a child slot. That slot is
 *   single-owner and the `read_image` row already declares it; a second
 *   declaration throws at bundle load, and a broken client half takes the whole
 *   conversation view with it. Images are drawn here directly instead.
 * - It does not import anything but React. The attachment gallery component is
 *   not importable from a plugin, and `loadImage` is the session-authorized
 *   loader the row is handed, so that is the way in.
 *
 * @module dsh-vision-reasoner/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-vision-reasoner',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The four tool names, which are also the slot keys that dispatch to us. */
    const TOOL_NAMES = ['vision_mark', 'vision_update', 'vision_show', 'vision_list']

    /** Durable image references out of a settled result's content blocks. */
    function imageRefs(block) {
      const content = Array.isArray(block?.content) ? block.content : []
      return content
        .filter((part) => part?.type === 'image' && part.attachment !== undefined)
        .map((part) => part.attachment)
    }

    /** The model-facing envelope, minus the image blocks it sits beside. */
    function resultText(block) {
      const content = Array.isArray(block?.content) ? block.content : []
      const first = content.find((part) => part?.type === 'text' && typeof part.text === 'string')
      return first === undefined ? '' : first.text
    }

    /**
     * One rendered view, collapsed to a thumbnail.
     *
     * `loadImage` is a promise plus an optional synchronous `peek`, so the first
     * paint uses the cache when it has one and the effect fills in the rest. A
     * URL that never arrives leaves nothing behind rather than a broken image.
     */
    function Picture({ attachment, loadImage, onOpen }) {
      const [url, setUrl] = React.useState(() =>
        typeof loadImage?.peek === 'function' ? loadImage.peek(attachment) : undefined)
      React.useEffect(() => {
        if (url !== undefined || typeof loadImage !== 'function') return undefined
        let live = true
        loadImage(attachment).then(
          (next) => { if (live) setUrl(next) },
          () => {}
        )
        return () => { live = false }
      }, [attachment, loadImage, url])
      if (url === undefined) return null
      return h('img', {
        src: url,
        alt: attachment?.name ?? 'rendered view',
        onClick: onOpen,
        title: 'Open this view in the side panel',
        style: {
          display: 'block',
          maxWidth: '100%',
          maxHeight: 160,
          margin: '8px 0 0',
          borderRadius: 'var(--dsw-radius-md, 6px)',
          border: '.5px solid var(--dsw-alias-border-l1)',
          cursor: 'zoom-in'
        }
      })
    }

    /**
     * The disclosure chevron, drawn the way the harness draws its own: a 14px
     * stroked SVG that points down when collapsed and up when open.
     */
    function Chevron({ expanded }) {
      const size = 'calc(14px + var(--dsh-content-font-delta, 0px))'
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: {
          transform: expanded ? 'rotate(180deg)' : 'none',
          transition: 'transform .1s'
        }
      }, h('path', { d: 'M4 6.5 8 10.5 12 6.5' }))
    }

    /**
     * The row itself.
     *
     * Every value here is read out of the harness's own tool row, printed by
     * `tools/row-css.mjs` from the shipped client bundle: 13px secondary text at
     * weight 400, tertiary label colour that lifts to secondary on hover, a 24px
     * line box, a 2px dot between title and summary, and a file link that is
     * `underline 1px dotted` at 3px offset. A row that hardcodes its own palette
     * and size looks like a different application.
     */
    function VisionRow(props) {
      const { block, toolName, loadImage, openFile, useDisclosure } = props
      const disclosure = typeof useDisclosure === 'function'
        ? useDisclosure()
        : { expanded: false, toggle() {} }
      const [hover, setHover] = React.useState(false)

      const meta = block?.meta ?? {}
      const refs = imageRefs(block)
      const path = typeof meta.path === 'string' && meta.path !== '' ? meta.path : undefined
      const marks = typeof meta.marks === 'number' && meta.marks > 0
        ? `${meta.marks} mark${meta.marks === 1 ? '' : 's'}`
        : null
      const text = resultText(block)
      const open = path !== undefined && typeof openFile === 'function' ? () => openFile(path) : undefined

      const secondary = 'var(--dsh-content-font-size-secondary, 13px)'
      const lineHeight = 'calc(24px + var(--dsh-content-font-delta, 0px))'
      const dot = {
        background: 'var(--dsw-alias-label-caption)',
        borderRadius: 1,
        flex: 'none',
        width: 2,
        height: 2,
        margin: '0 8px'
      }
      const link = {
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
        font: 'inherit',
        fontSize: secondary,
        lineHeight,
        textAlign: 'left',
        color: 'inherit',
        textUnderlineOffset: 3,
        cursor: 'pointer',
        background: '0 0',
        border: 'none',
        margin: 0,
        padding: 0,
        textDecoration: 'underline 1px dotted',
        overflow: 'hidden',
        maxWidth: '55%'
      }

      return h('div', {
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'flex',
          flexDirection: 'column',
          color: hover ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
          transition: 'color .1s'
        }
      },
        h('div', {
          onClick: disclosure.toggle,
          style: {
            display: 'flex',
            alignItems: 'center',
            height: lineHeight,
            minWidth: 0,
            cursor: 'pointer'
          }
        },
          h('span', {
            style: {
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 'calc(16px + var(--dsh-content-font-delta, 0px))',
              height: 'calc(16px + var(--dsh-content-font-delta, 0px))',
              marginRight: 6,
              color: 'inherit'
            }
          }, h(Chevron, { expanded: disclosure.expanded })),
          h('span', { style: { fontSize: secondary, fontWeight: 400, flex: 'none' } }, toolName ?? 'vision'),
          marks === null ? null : h('span', { style: dot, 'aria-hidden': true }),
          marks === null
            ? null
            : h('span', { style: { fontSize: secondary, lineHeight, flex: 'none', whiteSpace: 'nowrap' } }, marks),
          path === undefined ? null : h('span', { style: dot, 'aria-hidden': true }),
          path === undefined
            ? null
            : open === undefined
              ? h('span', { style: { ...link, cursor: 'default', textDecoration: 'none' }, title: path }, path)
              : h('button', {
                  type: 'button',
                  style: link,
                  title: `Open ${path} in the side panel`,
                  onClick: (event) => { event.stopPropagation(); open() }
                }, path)
        ),
        disclosure.expanded
          ? h('div', { style: { minWidth: 0 } },
              text === '' ? null : h('div', {
                style: { color: 'inherit', fontSize: secondary, lineHeight, whiteSpace: 'pre-wrap', marginTop: 2 }
              }, text),
              refs.map((attachment, index) => h(Picture, { key: index, attachment, loadImage, onOpen: open }))
            )
          : null
      )
    }

    return {
      inject: ['slots'],
      /**
       * Claim one row per tool name. The registration is an effect on this
       * plugin's fiber, so unloading the package removes the rows with it.
       * @param ctx - the browser half's context, carrying the slot registry.
       */
      apply(ctx) {
        for (const key of TOOL_NAMES) {
          ctx.slots.inject('tool.call.toolview',
            () => ctx.slots.register({ name: 'tool.call.toolview', key }, VisionRow))
        }
      }
    }
  }
})
