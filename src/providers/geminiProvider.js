import { env } from '~/config/environment'
import ApiError from '~/utils/ApiError'
import { StatusCodes } from 'http-status-codes'

// Danh sách các model theo thứ tự ưu tiên:
// 1. gemini-2.5-flash-lite: Tốc độ phản hồi cực nhanh (~1.2s), hạ tầng nhẹ, ít bị nghẽn tải cao (high demand)
// 2. gemini-2.5-flash: Model cân bằng chất lượng & tốc độ
// 3. gemini-flash-lite-latest: Pool dự phòng cho flash-lite
// 4. gemini-3.5-flash: Model thế hệ tiếp theo
const CANDIDATE_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash'
]
const PER_MODEL_TIMEOUT_MS = 14000

const generateBoardFromPrompt = async (prompt, customApiKey = '') => {
  const apiKey = (customApiKey || env.GEMINI_API_KEY || '').trim()

  if (!apiKey) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Chưa cấu hình GEMINI_API_KEY. Vui lòng thêm GEMINI_API_KEY vào .env hoặc cung cấp API Key cá nhân.'
    )
  }

  const systemInstruction = `You are an expert Agile & Kanban Project Manager.
Given a user request, generate a structured, comprehensive Kanban board.
Rules:
1. "title": descriptive board title (3 to 50 characters).
2. "columns": an array of 3 to 5 logical workflow columns (e.g. "To do", "In progress", "Review", "Done", or stage-based columns suitable for the domain).
3. "cards": for each column, create 2 to 4 actionable task cards.
   - "title": clear action-oriented task title (3 to 60 characters).
   - "description": clear explanation or instructions (can be empty string or brief markdown).
   - "labels": array of 1 to 2 label objects with "color" (hex color e.g. "#0052cc", "#e11d48", "#16a34a", "#d97706", "#7c3aed") and optional "title" (e.g. "Frontend", "Backend", "High Priority", "Research").
   - "checklists": optional array of checklist objects, each with "title" (e.g. "Checklist") and "items" (array of { "title": "step description" }).
Respond in the language of the prompt (if Vietnamese, use Vietnamese; if English, use English).`

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${systemInstruction}\n\nUser request: ${prompt}` }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.7
    }
  }

  let lastError = null

  for (const model of CANDIDATE_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(PER_MODEL_TIMEOUT_MS)
      })

      const data = await response.json()

      // Bất kỳ lỗi nào (503 High Demand, 429 Rate Limit, 404 Not Found, 500...),
      // ghi nhận và tự động fallback sang model tiếp theo trong danh sách
      if (!response.ok) {
        const errorMsg = data?.error?.message || response.statusText || 'Lỗi khi gọi Gemini API'
        lastError = new ApiError(response.status || StatusCodes.INTERNAL_SERVER_ERROR, errorMsg)
        continue
      }

      const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text
      if (!textContent) {
        lastError = new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Gemini không trả về nội dung hợp lệ.')
        continue
      }

      const parsedBoard = JSON.parse(textContent)
      if (!parsedBoard.title || !Array.isArray(parsedBoard.columns)) {
        lastError = new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, 'Dữ liệu AI sinh ra không đúng cấu trúc bảng Kanban.')
        continue
      }

      // Đảm bảo độ dài title không vượt quá 50 ký tự
      if (parsedBoard.title.length > 50) {
        parsedBoard.title = parsedBoard.title.substring(0, 50).trim()
      }

      return parsedBoard
    } catch (error) {
      // Khi model bị timeout hoặc network error, tiếp tục thử model tiếp theo
      lastError = error
    }
  }

  if (lastError instanceof ApiError) throw lastError
  throw new ApiError(
    StatusCodes.SERVICE_UNAVAILABLE,
    lastError?.message || 'Hệ thống AI tạm thời bận hoặc gặp sự cố kết nối. Vui lòng thử lại sau giây lát.'
  )
}

const chatWithCopilot = async ({
  message,
  history = [],
  boardContext = null,
  language = 'vi',
  customApiKey = '',
  attachments = [],
  localNowISO = null
}) => {
  const apiKey = (customApiKey || env.GEMINI_API_KEY || '').trim()

  if (!apiKey) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Chưa cấu hình GEMINI_API_KEY. Vui lòng thêm GEMINI_API_KEY vào .env hoặc cung cấp API Key cá nhân.'
    )
  }

  const langDirective = language === 'vi'
    ? 'The user interface is in Vietnamese. Default your response message and any generated board/column/card titles and descriptions to Vietnamese, unless the user specifically asks in English or another language.'
    : 'The user interface is in English. Default your response message and any generated board/column/card titles and descriptions to English, unless the user specifically asks in another language.'

  let boardContextText = ''
  if (boardContext && boardContext.title) {
    const colsSummary = (boardContext.columns || []).map(col => {
      const cardsList = (col.cards || []).slice(0, 30).map(card => {
        let cardStr = `"${card.title}"`
        const extra = []
        if (card.dueDate) {
          const dueStr = new Date(card.dueDate).toISOString()
          const remStr = (card.reminderMinutes !== null && card.reminderMinutes !== undefined)
            ? `${card.reminderMinutes}m`
            : 'none'
          extra.push(`Due: ${dueStr}, Reminder: ${remStr}`)
        }
        if (card.labels && card.labels.length > 0) {
          extra.push(`Labels: [${card.labels.map(l => l.title || l.color).join(', ')}]`)
        }
        if (card.checklists && card.checklists.length > 0) {
          const clSummary = card.checklists.map(cl => `${cl.title} (${(cl.items || []).filter(i => i.isDone).length}/${(cl.items || []).length})`).join('; ')
          extra.push(`Checklists: ${clSummary}`)
        }
        if (extra.length > 0) {
          cardStr += ` [${extra.join(' | ')}]`
        }
        return cardStr
      }).join('\n    - ')
      return `Column "${col.title}" (id: "${col._id}"):\n    - ${cardsList || 'No cards'}`
    }).join('\n')

    boardContextText = `
CURRENT ACTIVE BOARD:
- Board ID: "${boardContext._id}"
- Board Title: "${boardContext.title}"
- Description: "${boardContext.description || 'None'}"
- Columns & Tasks:
${colsSummary || 'No columns'}
- Board Members (name <email>):
${(boardContext.members || []).map((m) => `- ${m.displayName || m.email} <${m.email}>`).join('\n') || 'No members'}
`
  }

  const nowContextText = localNowISO
    ? `CURRENT USER LOCAL DATE/TIME: ${localNowISO}
Use this as the reference "now" to resolve relative dates in the user's request (e.g. "ngày mai" = tomorrow, "tuần sau" = next week, "9h" = 09:00 local time). Always output schedule dates in ISO 8601 WITH the user's UTC offset (e.g. "2026-11-23T09:00:00+07:00").
`
    : ''

  const systemInstruction = `You are Kanflow Assistant, an intelligent AI Assistant and Project Manager built into Kanflow (a real-time Kanban & Agile collaboration platform).
Your mission is to help users manage their workspaces, design boards, plan agile workflows, add/move/update cards, manage subtasks and checklists, set deadlines and reminders, add comments and labels, schedule calendar events, and answer productivity questions.

Language Guidelines:
${langDirective}

Multimodal & Image Guidelines:
Users can attach or paste images (screenshots, wireframes, diagrams, bug reports). If the user provides an image or attachment, inspect it thoroughly to answer questions, analyze workflows, describe tasks, or suggest boards/columns/cards.

CRITICAL SAFETY RULE - PERMANENT BOARD DELETION IS STRICTLY FORBIDDEN:
To protect user data against irreversible loss, Kanflow Assistant NEVER deletes boards permanently.
If a user asks to delete a board, you must set "action": null, "payload": null, and politely explain that deleting a board causes permanent data loss and must be performed manually by the owner in board settings, but offer to CLOSE the board instead via CLOSE_BOARD (which archives it safely without data loss).

Capabilities & Actions:
1. "CREATE_BOARD": When user asks to generate, create, or plan a new board/project/workflow.
   payload: {
     "title": "descriptive board title (max 50 chars)",
     "description": "brief board description",
     "columns": [
       {
         "title": "Column title",
         "cards": [
           {
             "title": "Task title (max 60 chars)",
             "description": "Clear explanation or instructions in markdown",
             "labels": [{ "title": "Tag name", "color": "#hex" }],
             "checklists": [{ "title": "Checklist", "items": [{ "title": "Subtask", "isDone": false }] }]
           }
         ]
       }
     ]
   }
2. "UPDATE_BOARD": Rename or update description of the CURRENT ACTIVE BOARD.
   payload: { "newTitle": "optional new title", "newDescription": "optional new description" }
3. "CLOSE_BOARD": When user asks to close/archive a board. You only IDENTIFY the board - the UI will ask the user to confirm before closing.
   payload: { "boardTitle": "optional board title from USER BOARDS; defaults to CURRENT ACTIVE BOARD" }
4. "REOPEN_BOARD": Reopen a closed board.
   payload: { "boardTitle": "board title from USER BOARDS" }
5. "CREATE_COLUMN": When user asks to add a column/stage/list to the current active board.
   payload: { "boardId": "${boardContext?._id || ''}", "title": "Column title" }
6. "UPDATE_COLUMN_TITLE": Rename a column of the CURRENT ACTIVE BOARD.
   payload: { "columnTitle": "current column title from board context", "newTitle": "new title" }
7. "DELETE_COLUMN": Permanently delete a column and all cards in it from the CURRENT ACTIVE BOARD (e.g. "xóa cột Backlog").
   payload: { "columnTitle": "exact column title to delete" }
8. "ARCHIVE_COLUMN": Archive (hide) a column of the CURRENT ACTIVE BOARD - reversible, nothing is deleted.
   payload: { "columnTitle": "column title to archive" }
9. "RESTORE_COLUMN": Restore a previously archived column of the CURRENT ACTIVE BOARD.
   payload: { "columnTitle": "archived column title to restore" }
9. "CREATE_CARD": When user asks to create or add a card/task to the current active board.
   payload: {
     "boardId": "${boardContext?._id || ''}",
     "columnId": "matching column _id from current active board, or leave empty/null if user didn't specify",
     "title": "Task title",
     "description": "Task description in markdown",
     "labels": [{ "title": "Tag name", "color": "#hex" }],
     "checklists": [{ "title": "Checklist", "items": [{ "title": "Subtask", "isDone": false }] }]
   }
10. "UPDATE_CARD": Update the title and/or description of an EXISTING card of the CURRENT ACTIVE BOARD. Copy card title EXACTLY.
    payload: { "cardTitle": "current card title from board context", "newTitle": "optional new title", "newDescription": "optional new description" }
11. "MOVE_CARD": Move a card (or all cards) to a different column (e.g. "chuyển thẻ X sang cột Done", "move task Y to In Progress", "chuyển tất cả thẻ To Do sang Doing").
    payload: {
      "cardTitle": "exact card title from board context, or 'all' if moving all cards in a column",
      "sourceColumnTitle": "optional source column title if moving all cards",
      "targetColumnTitle": "exact target column title from board context"
    }
12. "DELETE_CARD": Permanently delete a card from the CURRENT ACTIVE BOARD (e.g. "xóa thẻ X", "delete card Y").
    payload: { "cardTitle": "exact card title from board context" }
13. "ARCHIVE_CARD": Archive (hide) a card of the CURRENT ACTIVE BOARD.
    payload: { "cardTitle": "card title to archive" }
14. "RESTORE_CARD": Restore a previously archived card of the CURRENT ACTIVE BOARD.
    payload: { "cardTitle": "archived card title to restore" }
15. "UPDATE_CARD_DUE_DATE": Set/change deadlines (due dates, hạn chót) and/or reminders on EXISTING cards.
    - "dueDateISO": optional if card already has a due date.
    - "reminderMinutes": integer minutes before due date (0 = at due date, 10 = 10m before, 60 = 1h before, 120 = 2h before, 1440 = 1d before, 2880 = 2d before, null = none).
    - If user asks for "all cards", "entire of card", "tất cả các thẻ", include ALL cards from the board context!
    payload: {
      "updates": [
        { "title": "exact card title", "dueDateISO": "optional ISO string", "reminderMinutes": 120 }
      ]
    }
16. "UPDATE_CARD_REMINDER": Set or update reminders for cards (e.g. "update reminder entire of card before 2 hours", "nhắc trước 2 tiếng cho toàn bộ thẻ", "set reminder 1 hour before").
    - If cards already have due dates (see [DueDate: ...] in board context), DO NOT ask for date and time! Set reminderMinutes immediately.
    payload: {
      "reminderMinutes": 120,
      "allCards": true,
      "cardTitles": ["exact card title 1", "exact card title 2"]
    }
17. "ADD_CARD_LABEL": Add label(s) to a card (e.g. "thêm nhãn Bug màu đỏ cho thẻ X", "gắn nhãn Frontend").
    payload: {
      "cardTitle": "exact card title from board context",
      "labels": [{ "title": "label name", "color": "#hex color code like #0052cc, #ef4444, #10b981, #f59e0b" }]
    }
18. "ADD_CHECKLIST": Add a checklist with subtasks to a card (e.g. "thêm checklist Việc cần làm: Viết API, Viết Unit Test vào thẻ X").
    payload: {
      "cardTitle": "exact card title from board context",
      "checklistTitle": "Checklist title (e.g. Công việc / Subtasks)",
      "items": ["Subtask 1", "Subtask 2"]
    }
19. "CHECK_CHECKLIST_ITEM": Mark a subtask/checklist item done or undone (e.g. "đánh dấu hoàn thành mục A trong thẻ X", "tick done subtask Y").
    payload: {
      "cardTitle": "exact card title from board context",
      "itemTitle": "exact subtask title",
      "isDone": true
    }
20. "ADD_CARD_COMMENT": Add a comment to a card (e.g. "bình luận vào thẻ X nội dung 'Đã hoàn thành review code'").
    payload: {
      "cardTitle": "exact card title from board context",
      "content": "comment markdown content"
    }
21. "ADD_CARD_MEMBER": Assign a member to a card. Member must be in Board Members list.
    payload: { "cardTitle": "exact card title", "memberEmail": "exact email from Board Members" }
22. "REMOVE_CARD_MEMBER": Remove a member from a card.
    payload: { "cardTitle": "exact card title", "memberEmail": "exact email from Board Members" }
23. "INVITE_MEMBER": Invite a person to a board by email.
    payload: { "inviteeEmail": "email", "boardTitle": "optional board title" }
24. "CREATE_SCHEDULE": Plan a personal calendar entry (lịch cá nhân).
    payload: { "title": "schedule title", "startAtISO": "ISO string", "endAtISO": "ISO string", "colorKey": "blue", "description": "" }
25. "DELETE_SCHEDULE": Delete a personal calendar entry by title (e.g. "xóa lịch ôn tập tối nay").
    payload: { "scheduleTitle": "exact schedule title" }
26. General Conversation / Advice / Task Breakdown / Summary:
    When user asks a question, requests advice, says hi, or wants a summary.
    "action": null, "payload": null.

Output Rules:
You MUST ALWAYS respond with valid JSON matching this schema:
{
  "message": "Friendly, helpful markdown response to display to the user in chat",
  "action": null | "CREATE_BOARD" | "UPDATE_BOARD" | "CLOSE_BOARD" | "REOPEN_BOARD" | "CREATE_COLUMN" | "UPDATE_COLUMN_TITLE" | "DELETE_COLUMN" | "ARCHIVE_COLUMN" | "RESTORE_COLUMN" | "CREATE_CARD" | "UPDATE_CARD" | "MOVE_CARD" | "DELETE_CARD" | "ARCHIVE_CARD" | "RESTORE_CARD" | "UPDATE_CARD_DUE_DATE" | "UPDATE_CARD_REMINDER" | "ADD_CARD_LABEL" | "ADD_CHECKLIST" | "CHECK_CHECKLIST_ITEM" | "ADD_CARD_COMMENT" | "ADD_CARD_MEMBER" | "REMOVE_CARD_MEMBER" | "INVITE_MEMBER" | "CREATE_SCHEDULE" | "DELETE_SCHEDULE",
  "payload": null | object
}`

  const contents = []

  if (Array.isArray(history) && history.length > 0) {
    const recentHistory = history.slice(-6)
    for (const h of recentHistory) {
      if (h.role && h.content) {
        contents.push({
          role: h.role === 'assistant' || h.role === 'model' ? 'model' : 'user',
          parts: [{ text: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) }]
        })
      }
    }
  }

  const currentTurnText = `${systemInstruction}\n${nowContextText}${boardContextText}\nUser Message: ${message}`
  const userParts = [{ text: currentTurnText }]

  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (att?.mimeType && att?.base64) {
        userParts.push({
          inlineData: {
            mimeType: att.mimeType,
            data: att.base64
          }
        })
      }
    }
  }

  contents.push({
    role: 'user',
    parts: userParts
  })

  const requestBody = {
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.7
    }
  }

  let lastError = null

  for (const model of CANDIDATE_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(PER_MODEL_TIMEOUT_MS)
      })

      const data = await response.json()

      if (!response.ok) {
        const errorMsg = data?.error?.message || response.statusText || 'Lỗi khi gọi Gemini API'
        lastError = new ApiError(response.status || StatusCodes.INTERNAL_SERVER_ERROR, errorMsg)
        continue
      }

      const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text
      if (!textContent) {
        lastError = new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Gemini không trả về nội dung hợp lệ.')
        continue
      }

      const parsedResult = JSON.parse(textContent)
      if (!parsedResult.message) {
        parsedResult.message = language === 'vi'
          ? 'Tôi đã tiếp nhận yêu cầu của bạn.'
          : 'I have received your request.'
      }

      return parsedResult
    } catch (error) {
      lastError = error
    }
  }

  if (lastError instanceof ApiError) throw lastError
  throw new ApiError(
    StatusCodes.SERVICE_UNAVAILABLE,
    lastError?.message || 'Kanflow Assistant tạm thời bận hoặc gặp sự cố kết nối. Vui lòng thử lại sau giây lát.'
  )
}

export const geminiProvider = {
  generateBoardFromPrompt,
  chatWithCopilot
}
