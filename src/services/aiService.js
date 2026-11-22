import { geminiProvider } from '~/providers/geminiProvider'
import { boardService } from '~/services/boardService'
import { columnService } from '~/services/columnService'
import { cardService } from '~/services/cardService'
import { scheduleService } from '~/services/scheduleService'

const chat = async (userId, { message, history = [], currentBoardId = null, language = 'vi', customApiKey = '', attachments = [], localNowISO = null }) => {
  let boardContext = null
  if (currentBoardId) {
    try {
      boardContext = await boardService.getDetails(userId, currentBoardId)
    } catch {
      boardContext = null
    }
  }

  const aiResult = await geminiProvider.chatWithCopilot({
    message,
    history,
    boardContext,
    language,
    customApiKey,
    attachments,
    localNowISO
  })

  let actionResult = null

  if (aiResult.action === 'CREATE_BOARD' && aiResult.payload?.title) {
    try {
      const createdBoard = await boardService.importBoard(userId, aiResult.payload)
      actionResult = {
        type: 'BOARD_CREATED',
        data: createdBoard
      }
    } catch (err) {
      aiResult.message += language === 'vi'
        ? `\n\n*(Lưu ý: Không thể tự động tạo bảng do: ${err.message})*`
        : `\n\n*(Note: Could not automatically create board due to: ${err.message})*`
    }
  } else if (aiResult.action === 'CREATE_COLUMN' && aiResult.payload?.title) {
    try {
      const targetBoardId = aiResult.payload.boardId || currentBoardId
      if (targetBoardId) {
        const createdColumn = await columnService.createNew(userId, {
          boardId: targetBoardId,
          title: aiResult.payload.title
        })
        actionResult = {
          type: 'COLUMN_CREATED',
          data: createdColumn
        }
      }
    } catch (err) {
      aiResult.message += language === 'vi'
        ? `\n\n*(Lưu ý: Không thể tự động tạo cột do: ${err.message})*`
        : `\n\n*(Note: Could not automatically create column due to: ${err.message})*`
    }
  } else if (aiResult.action === 'CREATE_CARD' && aiResult.payload?.title) {
    try {
      const targetBoardId = aiResult.payload.boardId || currentBoardId
      let targetColumnId = aiResult.payload.columnId

      // Nếu không có columnId hoặc columnId không tìm thấy, lấy cột đầu tiên của board hiện tại
      if ((!targetColumnId || targetColumnId === 'null') && boardContext?.columns?.length > 0) {
        targetColumnId = boardContext.columns[0]._id.toString()
      }

      if (targetBoardId && targetColumnId) {
        const createdCard = await cardService.createNew(userId, {
          boardId: targetBoardId,
          columnId: targetColumnId.toString(),
          title: aiResult.payload.title,
          description: aiResult.payload.description || '',
          labels: aiResult.payload.labels || [],
          checklists: aiResult.payload.checklists || []
        })
        actionResult = {
          type: 'CARD_CREATED',
          data: createdCard
        }
      }
    } catch (err) {
      aiResult.message += language === 'vi'
        ? `\n\n*(Lưu ý: Không thể tự động tạo thẻ do: ${err.message})*`
        : `\n\n*(Note: Could not automatically create card due to: ${err.message})*`
    }
  } else if (aiResult.action === 'CREATE_SCHEDULE' && aiResult.payload?.title) {
    try {
      const startAt = Date.parse(aiResult.payload.startAtISO)
      const endAt = Date.parse(aiResult.payload.endAtISO)

      if (Number.isNaN(startAt) || Number.isNaN(endAt)) {
        throw new Error('Invalid schedule datetime (startAtISO/endAtISO)')
      }
      if (endAt <= startAt) {
        throw new Error('Schedule end time must be after start time')
      }

      const createdEntry = await scheduleService.createNewEntry({
        title: aiResult.payload.title,
        description: aiResult.payload.description || '',
        startAt,
        endAt,
        colorKey: aiResult.payload.colorKey
      }, userId)

      actionResult = {
        type: 'SCHEDULE_CREATED',
        data: createdEntry
      }
    } catch (err) {
      aiResult.message += language === 'vi'
        ? `\n\n*(Lưu ý: Không thể tự động tạo lịch do: ${err.message})*`
        : `\n\n*(Note: Could not automatically create schedule due to: ${err.message})*`
    }
  }

  return {
    message: aiResult.message,
    action: aiResult.action,
    actionResult
  }
}

export const aiService = {
  chat
}
