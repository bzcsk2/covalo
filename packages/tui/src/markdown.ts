import chalk from 'chalk'
import { marked, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { stringWidth } from '@deepicode/ink'

const EOL = '\n'

let markedConfigured = false

export function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true
  marked.use({
    tokenizer: {
      del() { return undefined },
    },
  })
}

export function applyMarkdown(content: string): string {
  configureMarked()
  return marked
    .lexer(content)
    .map(_ => formatToken(_, 0, null, null))
    .join('')
    .trim()
}

export function formatToken(
  token: Token,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? [])
        .map(_ => formatToken(_, 0, null, null))
        .join('')
      const bar = chalk.dim('│')
      return inner
        .split(EOL)
        .map(line => stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line)
        .join(EOL)
    }
    case 'code': {
      return token.text + EOL
    }
    case 'codespan': {
      return chalk.cyan(token.text)
    }
    case 'em':
      return chalk.italic(
        (token.tokens ?? [])
          .map(_ => formatToken(_, 0, null, parent))
          .join(''),
      )
    case 'strong':
      return chalk.bold(
        (token.tokens ?? [])
          .map(_ => formatToken(_, 0, null, parent))
          .join(''),
      )
    case 'heading':
      switch (token.depth) {
        case 1:
          return chalk.bold.underline(
            (token.tokens ?? []).map(_ => formatToken(_, 0, null, null)).join('')
          ) + EOL + EOL
        case 2:
          return chalk.bold(
            (token.tokens ?? []).map(_ => formatToken(_, 0, null, null)).join('')
          ) + EOL + EOL
        default:
          return chalk.bold(
            (token.tokens ?? []).map(_ => formatToken(_, 0, null, null)).join('')
          ) + EOL + EOL
      }
    case 'hr':
      return '---'
    case 'image':
      return token.href
    case 'link': {
      if (token.href.startsWith('mailto:')) {
        return token.href.replace(/^mailto:/, '')
      }
      const linkText = (token.tokens ?? [])
        .map(_ => formatToken(_, 0, null, token))
        .join('')
      const plainLinkText = stripAnsi(linkText)
      if (plainLinkText && plainLinkText !== token.href) {
        return `${plainLinkText} (${token.href})`
      }
      return token.href
    }
    case 'list': {
      return token.items
        .map((_: Token, index: number) =>
          formatToken(_, listDepth, token.ordered ? token.start + index : null, token)
        )
        .join('')
    }
    case 'list_item':
      return (token.tokens ?? [])
        .map(_ =>
          `${'  '.repeat(listDepth)}${formatToken(_, listDepth + 1, orderedListNumber, token)}`
        )
        .join('')
    case 'paragraph':
      return (token.tokens ?? [])
        .map(_ => formatToken(_, 0, null, null))
        .join('') + EOL
    case 'space':
      return EOL
    case 'br':
      return EOL
    case 'text':
      if (parent?.type === 'list_item') {
        return `${orderedListNumber === null ? '-' : orderedListNumber + '.'} ${token.tokens ? token.tokens.map(_ => formatToken(_, listDepth, orderedListNumber, token)).join('') : token.text}${EOL}`
      }
      return token.text
    case 'table': {
      const tableToken = token as Tokens.Table
      function getDisplayText(tokens: Token[] | undefined): string {
        return stripAnsi(tokens?.map(_ => formatToken(_, 0, null, null)).join('') ?? '')
      }
      const columnWidths = tableToken.header.map((header, index) => {
        let maxWidth = stringWidth(getDisplayText(header.tokens))
        for (const row of tableToken.rows) {
          const cellLength = stringWidth(getDisplayText(row[index]?.tokens))
          maxWidth = Math.max(maxWidth, cellLength)
        }
        return Math.max(maxWidth, 3)
      })
      let tableOutput = '| '
      tableToken.header.forEach((header, index) => {
        const content = header.tokens?.map(_ => formatToken(_, 0, null, null)).join('') ?? ''
        const displayText = getDisplayText(header.tokens)
        const width = columnWidths[index]!
        const align = tableToken.align?.[index]
        tableOutput += padAligned(content, stringWidth(displayText), width, align) + ' | '
      })
      tableOutput = tableOutput.trimEnd() + EOL
      tableOutput += '|'
      columnWidths.forEach(width => {
        tableOutput += '-'.repeat(width + 2) + '|'
      })
      tableOutput += EOL
      tableToken.rows.forEach(row => {
        tableOutput += '| '
        row.forEach((cell, index) => {
          const content = cell.tokens?.map(_ => formatToken(_, 0, null, null)).join('') ?? ''
          const displayText = getDisplayText(cell.tokens)
          const width = columnWidths[index]!
          const align = tableToken.align?.[index]
          tableOutput += padAligned(content, stringWidth(displayText), width, align) + ' | '
        })
        tableOutput = tableOutput.trimEnd() + EOL
      })
      return tableOutput + EOL
    }
    case 'escape':
      return token.text
    case 'def':
    case 'del':
    case 'html':
      return ''
  }
  return ''
}

export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}
