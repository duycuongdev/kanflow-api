import { geminiProvider } from '~/providers/geminiProvider'
import { boardService } from '~/services/boardService'
import { cardService } from '~/services/cardService'
import { columnService } from '~/services/columnService'
import { invitationService } from '~/services/invitationService'
import { userModel } from '~/models/userModel'
import { scheduleService } from '~/services/scheduleService'
import { GET_DB } from '~/config/mongodb'
import { ObjectId } from 'mongodb'
import { randomUUID } from 'crypto'

const escapeRegex = (string) => String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Format epoch ms theo múi giờ của user (offset lấy từ localNowISO client gửi lên, vd '+07:00')
const NEWLINE2 = '\n\n'

const noBoardMsg = (language) => language === 'vi'
  ? 'Bạn cần mở một bảng trước khi thao tác với cột hoặc card.'
  : 'Open a board first before working with columns or cards.'

// Tìm board của user theo title (không phân biệt hoa thường), trả về { board, matches }
const resolveUserBoardByTitle = async (userId, wantedTitle) => {
  const userBoards = await boardService.getBoards(userId, 1, 100)
  const wanted = String(wantedTitle || '').trim().toLowerCase()
  const matches = (userBoards?.boards || []).filter((b) => {
    const t = (b.title || '').toLowerCase()
    return t === wanted || t.includes(wanted) || wanted.includes(t)
  })
  return { board: matches[0] || null, matches }
}

const dayjsFmt = (epochMs, offsetMinutes = 0) => {
  const d = new Date(epochMs + offsetMinutes * 60000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// Đọc offset phút từ chuỗi localNowISO (vd '2026-11-22T17:30:00+07:00' -> 420)
const tzOffsetMinutesFrom = (localNowISO) => {
  const m = String(localNowISO || '').match(/([+-])(\d{2}):?(\d{2})\s*$/)
  if (!m) return 0
  const value = parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
  return m[1] === '-' ? -value : value
}

const chat = async (userId, { message, history = [], currentBoardId = null, language = 'vi', customApiKey = '', attachments = [], localNowISO = null }) => {
  let boardContext = null
  if (currentBoardId) {
    try {
      boardContext = await boardService.getDetails(userId, currentBoardId)
    } catch {
      boardContext = null
    }
  }

  const offsetMinutes = tzOffsetMinutesFrom(localNowISO)

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

  // CRITICAL SAFETY GUARD: Board permanent deletion is strictly forbidden via AI
  if (aiResult.action === 'DELETE_BOARD') {
    actionResult = null
    aiResult.action = null
    aiResult.message = (language === 'vi'
      ? '⚠️ **Quy tắc an toàn hệ thống**: Kanflow Assistant không hỗ trợ thao tác xóa bảng vĩnh viễn nhằm bảo vệ an toàn tuyệt đối cho dữ liệu dự án của bạn. Thao tác xóa vĩnh viễn bảng chỉ có thể thực hiện thủ công bởi Chủ sở hữu (Owner) trong phần Cài đặt bảng.\n\nNếu muốn tạm ẩn bảng khỏi giao diện làm việc mà vẫn bảo toàn 100% dữ liệu để có thể mở lại bất cứ lúc nào, bạn có muốn tôi giúp bạn **Đóng bảng** (Close Board) không?'
      : '⚠️ **System Safety Policy**: Kanflow Assistant cannot permanently delete boards in order to protect project data against irreversible loss. Permanent deletion must be executed manually by the Board Owner in Board Settings.\n\nIf you want to hide this board while preserving 100% of data (reopenable anytime), would you like me to **Close the board** instead?')
  } else if (aiResult.action === 'CREATE_BOARD' && aiResult.payload?.title) {
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
  } else if ((aiResult.action === 'UPDATE_CARD_DUE_DATE' || aiResult.action === 'UPDATE_CARD_REMINDER') && aiResult.payload) {
    try {
      // Chỉ thao tác trên board đang mở: user phải là owner/member của board chứa card (cardService.update tự kiểm tra IDOR)
      if (!currentBoardId || !boardContext) {
        throw new Error(language === 'vi'
          ? 'Bạn cần mở một bảng trước khi đặt hạn chót hoặc nhắc nhở cho card.'
          : 'Open a board first before setting card deadlines or reminders.')
      }

      // Gom card của board theo title (case-insensitive) từ boardContext
      const boardCards = (boardContext.columns || [])
        .flatMap((col) => (col.cards || []).map((c) => ({ ...c, columnTitle: col.title })))

      let rawUpdates = []
      const payload = aiResult.payload

      // 1. Trường hợp payload có updates mảng
      if (Array.isArray(payload.updates) && payload.updates.length > 0) {
        const isAllCardsFlag = payload.updates.some(u => {
          const t = String(u.title || '').trim().toLowerCase()
          return t === 'all' || t === '*' || t === 'all cards' || t === 'all card' || t === 'tất cả' || t === 'toàn bộ'
        })
        if (isAllCardsFlag) {
          const allItem = payload.updates.find(u => {
            const t = String(u.title || '').trim().toLowerCase()
            return t === 'all' || t === '*' || t === 'all cards' || t === 'all card' || t === 'tất cả' || t === 'toàn bộ'
          })
          rawUpdates = boardCards.map(c => ({
            title: c.title,
            dueDateISO: allItem?.dueDateISO,
            reminderMinutes: allItem?.reminderMinutes !== undefined ? allItem.reminderMinutes : payload.reminderMinutes
          }))
        } else {
          rawUpdates = payload.updates
        }
      }
      // 2. Trường hợp payload có allCards = true hoặc cardTitles bao gồm "all" / "*" / null
      else if (payload.allCards === true || payload.cardTitles?.includes('all') || payload.cardTitles?.includes('*') || (!payload.cardTitles && payload.reminderMinutes !== undefined)) {
        rawUpdates = boardCards.map(c => ({
          title: c.title,
          reminderMinutes: payload.reminderMinutes,
          dueDateISO: payload.dueDateISO
        }))
      }
      // 3. Trường hợp payload có cardTitles là mảng các title cụ thể
      else if (Array.isArray(payload.cardTitles)) {
        rawUpdates = payload.cardTitles.map(t => ({
          title: t,
          reminderMinutes: payload.reminderMinutes,
          dueDateISO: payload.dueDateISO
        }))
      }

      const updated = []
      const notFound = []
      const invalidDates = []

      for (const upd of rawUpdates) {
        const title = String(upd.title || '').trim()
        if (!title) continue
        const card = boardCards.find((c) => c.title.toLowerCase() === title.toLowerCase())
        if (!card) {
          notFound.push(title)
          continue
        }

        const updateData = {}
        if (upd.dueDateISO) {
          const dueDate = Date.parse(upd.dueDateISO)
          if (Number.isNaN(dueDate)) {
            invalidDates.push(title)
            continue
          }
          updateData.dueDate = dueDate
        }

        if (upd.reminderMinutes !== undefined) {
          updateData.reminderMinutes = (upd.reminderMinutes === null || upd.reminderMinutes === -1)
            ? null
            : Number(upd.reminderMinutes)
        }

        if (Object.keys(updateData).length === 0) continue

        await cardService.update(card._id.toString(), updateData, undefined, { _id: userId })
        updated.push({
          title: card.title,
          dueDate: updateData.dueDate || card.dueDate,
          reminderMinutes: updateData.reminderMinutes !== undefined ? updateData.reminderMinutes : card.reminderMinutes,
          columnTitle: card.columnTitle
        })
      }

      const reminderDesc = (mins) => {
        if (mins === null || mins === -1) return language === 'vi' ? 'tắt nhắc' : 'no reminder'
        if (mins === 0) return language === 'vi' ? 'đúng giờ' : 'at due time'
        if (mins < 60) return language === 'vi' ? `trước ${mins} phút` : `${mins}m before`
        if (mins < 1440) return language === 'vi' ? `trước ${mins / 60} giờ` : `${mins / 60}h before`
        return language === 'vi' ? `trước ${mins / 1440} ngày` : `${mins / 1440}d before`
      }

      let summary = ''
      if (updated.length > 0) {
        const details = updated.map((u) => {
          let s = `"${u.title}"`
          const parts = []
          if (u.dueDate) parts.push(dayjsFmt(u.dueDate, offsetMinutes))
          if (u.reminderMinutes !== undefined) parts.push(reminderDesc(u.reminderMinutes))
          if (parts.length > 0) s += ` (${parts.join(', ')})`
          return s
        }).join(', ')

        summary = language === 'vi'
          ? `\n\n⏰ Đã cập nhật hạn chót / nhắc nhở cho ${updated.length} card: ${details}`
          : `\n\n⏰ Updated due date / reminder for ${updated.length} cards: ${details}`
      }

      if (notFound.length > 0) {
        summary += language === 'vi'
          ? '. Không tìm thấy: ' + notFound.join(', ')
          : '. Not found: ' + notFound.join(', ')
      }
      if (invalidDates.length > 0) {
        summary += language === 'vi'
          ? '. Ngày không hợp lệ: ' + invalidDates.join(', ')
          : '. Invalid dates: ' + invalidDates.join(', ')
      }
      aiResult.message += summary

      actionResult = {
        type: 'CARDS_DUE_DATE_UPDATED',
        data: { updatedCount: updated.length, updated, notFound, invalidDates }
      }
    } catch (err) {
      aiResult.message += language === 'vi'
        ? `\n\n*(Lưu ý: Không thể cập nhật do: ${err.message})*`
        : `\n\n*(Note: Could not update due dates/reminders due to: ${err.message})*`
    }
  } else if (aiResult.action === 'UPDATE_COLUMN_TITLE' && aiResult.payload?.columnTitle && aiResult.payload?.newTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const column = (boardContext.columns || []).find((c) => c.title.toLowerCase() === String(aiResult.payload.columnTitle).toLowerCase())
      if (!column) throw new Error('Column not found in the current board')
      const newTitle = String(aiResult.payload.newTitle).trim()
      if (!newTitle) throw new Error('New column title is empty')
      await columnService.update(userId, column._id.toString(), { title: newTitle })
      actionResult = { type: 'COLUMN_UPDATED', data: { columnId: column._id.toString(), title: newTitle } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📝 Đã đổi tên cột thành "' + newTitle + '"' : '📝 Column renamed to "' + newTitle + '"')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'ARCHIVE_COLUMN' && aiResult.payload?.columnTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const column = (boardContext.columns || []).find((c) => c.title.toLowerCase() === String(aiResult.payload.columnTitle).toLowerCase())
      if (!column) throw new Error('Column not found in the current board')
      await columnService.archiveColumn(userId, column._id.toString())
      actionResult = { type: 'COLUMN_ARCHIVED', data: { columnId: column._id.toString(), title: column.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📦 Đã lưu trữ cột "' + column.title + '" (có thể khôi phục)' : '📦 Column "' + column.title + '" archived (restorable)')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'RESTORE_COLUMN' && aiResult.payload?.columnTitle) {
    try {
      if (!currentBoardId) throw new Error(noBoardMsg(language))
      const archived = await boardService.getArchivedItems(userId, currentBoardId)
      const column = (archived.columns || []).find((c) => c.title.toLowerCase() === String(aiResult.payload.columnTitle).toLowerCase())
      if (!column) throw new Error('No archived column matching that title')
      await columnService.restoreColumn(userId, column._id.toString())
      actionResult = { type: 'COLUMN_RESTORED', data: { columnId: column._id.toString(), title: column.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📂 Đã khôi phục cột "' + column.title + '"' : '📂 Column "' + column.title + '" restored')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'UPDATE_CARD' && aiResult.payload?.cardTitle && (aiResult.payload?.newTitle || aiResult.payload?.newDescription)) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || []).map((c) => ({ ...c, columnTitle: col.title }))).find((c) => c.title.toLowerCase() === String(aiResult.payload.cardTitle).toLowerCase())
      if (!card) throw new Error('Card not found in the current board')
      const updateData = {}
      if (aiResult.payload.newTitle) updateData.title = String(aiResult.payload.newTitle).trim()
      if (aiResult.payload.newDescription !== undefined) updateData.description = String(aiResult.payload.newDescription)
      if (Object.keys(updateData).length === 0) throw new Error('Nothing to update')
      await cardService.update(card._id.toString(), updateData, undefined, { _id: userId })
      actionResult = { type: 'CARD_UPDATED', data: { cardId: card._id.toString(), title: updateData.title || card.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📝 Đã cập nhật card "' + (updateData.title || card.title) + '"' : '📝 Card "' + (updateData.title || card.title) + '" updated')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'ARCHIVE_CARD' && aiResult.payload?.cardTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || [])).find((c) => c.title.toLowerCase() === String(aiResult.payload.cardTitle).toLowerCase())
      if (!card) throw new Error('Card not found in the current board')
      await cardService.archiveCard(userId, card._id.toString())
      actionResult = { type: 'CARD_ARCHIVED', data: { cardId: card._id.toString(), title: card.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📦 Đã lưu trữ card "' + card.title + '" (có thể khôi phục)' : '📦 Card "' + card.title + '" archived (restorable)')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'RESTORE_CARD' && aiResult.payload?.cardTitle) {
    try {
      if (!currentBoardId) throw new Error(noBoardMsg(language))
      const archived = await boardService.getArchivedItems(userId, currentBoardId)
      const card = (archived.cards || []).find((c) => c.title.toLowerCase() === String(aiResult.payload.cardTitle).toLowerCase())
      if (!card) throw new Error('No archived card matching that title')
      await cardService.restoreCard(userId, card._id.toString())
      actionResult = { type: 'CARD_RESTORED', data: { cardId: card._id.toString(), title: card.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📂 Đã khôi phục card "' + card.title + '"' : '📂 Card "' + card.title + '" restored')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'INVITE_MEMBER' && aiResult.payload?.inviteeEmail) {
    try {
      const inviteeEmail = String(aiResult.payload.inviteeEmail).trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteeEmail)) throw new Error('Invalid invitee email')
      let boardIdToInvite = currentBoardId
      let boardTitleToInvite = boardContext?.title || null
      if (!boardIdToInvite && aiResult.payload.boardTitle) {
        const resolved = await resolveUserBoardByTitle(userId, aiResult.payload.boardTitle)
        if (!resolved.board || resolved.matches.length > 1) throw new Error('Board not found or ambiguous')
        boardIdToInvite = resolved.board._id.toString()
        boardTitleToInvite = resolved.board.title
      }
      if (!boardIdToInvite) throw new Error(noBoardMsg(language))
      await invitationService.createNewBoardInvitation({ inviteeEmail, boardId: boardIdToInvite }, userId)
      actionResult = { type: 'MEMBER_INVITED', data: { inviteeEmail, boardTitle: boardTitleToInvite } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📧 Đã gửi lời mời tới ' + inviteeEmail + ' vào bảng "' + (boardTitleToInvite || '') + '"' : '📧 Invitation sent to ' + inviteeEmail + ' for "' + (boardTitleToInvite || '') + '"')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'CLOSE_BOARD' && (aiResult.payload?.boardTitle || currentBoardId)) {
    try {
      let boardIdToClose = currentBoardId
      let boardTitleToClose = boardContext?.title || null
      if (aiResult.payload?.boardTitle) {
        const resolved = await resolveUserBoardByTitle(userId, aiResult.payload.boardTitle)
        if (!resolved.board || resolved.matches.length > 1) throw new Error('Board not found or ambiguous')
        boardIdToClose = resolved.board._id.toString()
        boardTitleToClose = resolved.board.title
      }
      if (!boardIdToClose) throw new Error(noBoardMsg(language))
      // KHÔNG tự đóng: trả về xác nhận để user bấm nút trên UI (tránh AI đóng nhầm bảng đang mở)
      actionResult = {
        type: 'BOARD_CLOSE_CONFIRMATION',
        data: { _id: boardIdToClose, title: boardTitleToClose }
      }
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '⚠️ Bấm nút bên dưới để xác nhận đóng bảng (có thể mở lại sau).'
        : NEWLINE2 + '⚠️ Click the button below to confirm closing the board (reopenable).'
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'REOPEN_BOARD' && aiResult.payload?.boardTitle) {
    try {
      const resolved2 = await resolveUserBoardByTitle(userId, aiResult.payload.boardTitle)
      if (!resolved2.board || resolved2.matches.length > 1) throw new Error('Board not found or ambiguous')
      await boardService.reopenBoard(userId, resolved2.board._id.toString())
      actionResult = { type: 'BOARD_REOPENED', data: { _id: resolved2.board._id.toString(), title: resolved2.board.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '🔓 Đã mở lại bảng "' + resolved2.board.title + '"' : '🔓 Board "' + resolved2.board.title + '" reopened')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'ADD_CARD_MEMBER' && aiResult.payload?.cardTitle && aiResult.payload?.memberEmail) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || []).map((c) => ({ ...c, columnTitle: col.title }))).find((c) => c.title.toLowerCase() === String(aiResult.payload.cardTitle).toLowerCase())
      if (!card) throw new Error('Card not found in the current board')
      const memberUser = await userModel.findOneByEmail(String(aiResult.payload.memberEmail).trim().toLowerCase())
      if (!memberUser) throw new Error('No user found with that email')
      const isBoardMember = [...(boardContext.ownerIds || []), ...(boardContext.memberIds || [])].some((id) => id.toString() === memberUser._id.toString())
      if (!isBoardMember) throw new Error('That user is not a member of this board yet - invite them to the board first')
      const memberIds = (card.memberIds || []).map((id) => id.toString())
      if (memberIds.includes(memberUser._id.toString())) throw new Error('That user is already a member of this card')
      await cardService.update(card._id.toString(), { memberIds: [...memberIds, memberUser._id.toString()] }, undefined, { _id: userId })
      actionResult = { type: 'CARD_MEMBER_ADDED', data: { cardId: card._id.toString(), cardTitle: card.title, memberEmail: memberUser.email, memberName: memberUser.displayName } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '👥 Đã thêm ' + memberUser.displayName + ' vào card "' + card.title + '"' : '👥 Added ' + memberUser.displayName + ' to the card "' + card.title + '"')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thêm thành viên vào card do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not add the card member due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'REMOVE_CARD_MEMBER' && aiResult.payload?.cardTitle && aiResult.payload?.memberEmail) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || []).map((c) => ({ ...c, columnTitle: col.title }))).find((c) => c.title.toLowerCase() === String(aiResult.payload.cardTitle).toLowerCase())
      if (!card) throw new Error('Card not found in the current board')
      const memberUser = await userModel.findOneByEmail(String(aiResult.payload.memberEmail).trim().toLowerCase())
      if (!memberUser) throw new Error('No user found with that email')
      const memberIds = (card.memberIds || []).map((id) => id.toString())
      if (!memberIds.includes(memberUser._id.toString())) throw new Error('That user is not a member of this card')
      await cardService.update(card._id.toString(), { memberIds: memberIds.filter((id) => id !== memberUser._id.toString()) }, undefined, { _id: userId })
      actionResult = { type: 'CARD_MEMBER_REMOVED', data: { cardId: card._id.toString(), cardTitle: card.title, memberEmail: memberUser.email, memberName: memberUser.displayName } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '👤 Đã xóa ' + memberUser.displayName + ' khỏi card "' + card.title + '"' : '👤 Removed ' + memberUser.displayName + ' from the card "' + card.title + '"')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể xóa thành viên khỏi card do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not remove the card member due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'UPDATE_BOARD' && (aiResult.payload?.newTitle || aiResult.payload?.newDescription !== undefined)) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const updateData = {}
      if (aiResult.payload.newTitle) updateData.title = String(aiResult.payload.newTitle).trim()
      if (aiResult.payload.newDescription !== undefined) updateData.description = String(aiResult.payload.newDescription)
      if (Object.keys(updateData).length === 0) throw new Error('Nothing to update')

      const updatedBoard = await boardService.update(userId, currentBoardId, updateData)
      actionResult = {
        type: 'BOARD_UPDATED',
        data: updatedBoard
      }
      aiResult.message += NEWLINE2 + (language === 'vi'
        ? `📋 Đã cập nhật thông tin bảng "${updatedBoard.title || boardContext.title}" thành công.`
        : `📋 Successfully updated board "${updatedBoard.title || boardContext.title}".`)
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể cập nhật bảng do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not update board due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'DELETE_COLUMN' && aiResult.payload?.columnTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const column = (boardContext.columns || []).find((c) => c.title.toLowerCase() === String(aiResult.payload.columnTitle).toLowerCase().trim())
      if (!column) throw new Error('Column not found in the current board')
      await columnService.deleteItem(userId, column._id.toString())
      actionResult = { type: 'COLUMN_DELETED', data: { columnId: column._id.toString(), title: column.title } }
      aiResult.message += NEWLINE2 + (language === 'vi'
        ? `🗑️ Đã xóa vĩnh viễn cột "${column.title}" và các thẻ bên trong.`
        : `🗑️ Column "${column.title}" and its cards were permanently deleted.`)
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể xóa cột do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not delete column due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'MOVE_CARD' && aiResult.payload?.targetColumnTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const targetColName = String(aiResult.payload.targetColumnTitle).trim().toLowerCase()
      const targetColumn = (boardContext.columns || []).find((c) => {
        const t = c.title.toLowerCase()
        return t === targetColName || t.includes(targetColName) || targetColName.includes(t)
      })
      if (!targetColumn) throw new Error('Target column not found in the current board')

      const isAll = String(aiResult.payload.cardTitle || '').trim().toLowerCase() === 'all' ||
                    String(aiResult.payload.cardTitle || '').trim().toLowerCase() === 'toàn bộ' ||
                    String(aiResult.payload.cardTitle || '').trim().toLowerCase() === 'tất cả' ||
                    String(aiResult.payload.cardTitle || '').trim() === '*'

      let cardsToMove = []
      if (isAll && aiResult.payload.sourceColumnTitle) {
        const srcColName = String(aiResult.payload.sourceColumnTitle).trim().toLowerCase()
        const srcCol = (boardContext.columns || []).find((c) => {
          const t = c.title.toLowerCase()
          return t === srcColName || t.includes(srcColName) || srcColName.includes(t)
        })
        if (srcCol) {
          cardsToMove = (srcCol.cards || []).map(c => ({ card: c, sourceColumn: srcCol }))
        }
      } else if (Array.isArray(aiResult.payload.cardTitles) && aiResult.payload.cardTitles.length > 0) {
        for (const t of aiResult.payload.cardTitles) {
          const tLower = String(t).trim().toLowerCase()
          const found = (boardContext.columns || []).flatMap(col => (col.cards || []).map(c => ({ card: c, sourceColumn: col }))).find(item => {
            const ct = item.card.title.toLowerCase()
            return ct === tLower || ct.includes(tLower) || tLower.includes(ct)
          })
          if (found) cardsToMove.push(found)
        }
      } else if (aiResult.payload.cardTitle) {
        const cardTitleLower = String(aiResult.payload.cardTitle).trim().toLowerCase()
        const found = (boardContext.columns || []).flatMap(col => (col.cards || []).map(c => ({ card: c, sourceColumn: col }))).find(item => {
          const ct = item.card.title.toLowerCase()
          return ct === cardTitleLower || ct.includes(cardTitleLower) || cardTitleLower.includes(ct)
        })
        if (found) cardsToMove.push(found)
      }

      if (cardsToMove.length === 0) throw new Error('No matching cards found to move')

      const colOrderMap = {}
      boardContext.columns.forEach(col => {
        colOrderMap[col._id.toString()] = [...(col.cardOrderIds || []).map(id => id.toString())]
      })

      const movedCards = []
      for (const { card, sourceColumn } of cardsToMove) {
        if (sourceColumn._id.toString() === targetColumn._id.toString()) continue

        const prevColId = sourceColumn._id.toString()
        const nextColId = targetColumn._id.toString()

        colOrderMap[prevColId] = colOrderMap[prevColId].filter(id => id !== card._id.toString())
        colOrderMap[nextColId] = [...colOrderMap[nextColId].filter(id => id !== card._id.toString()), card._id.toString()]

        await boardService.moveCardToDifferentColumn(userId, {
          currentCardId: card._id.toString(),
          prevColumnId: prevColId,
          prevCardOrderIds: colOrderMap[prevColId],
          nextColumnId: nextColId,
          nextCardOrderIds: colOrderMap[nextColId]
        })
        movedCards.push(card.title)
      }

      actionResult = {
        type: 'CARD_MOVED',
        data: { movedCount: movedCards.length, cards: movedCards, targetColumnTitle: targetColumn.title }
      }
      aiResult.message += NEWLINE2 + (language === 'vi'
        ? `🔄 Đã chuyển ${movedCards.length} thẻ (${movedCards.join(', ')}) sang cột "${targetColumn.title}".`
        : `🔄 Moved ${movedCards.length} card(s) (${movedCards.join(', ')}) to column "${targetColumn.title}".`)
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể di chuyển thẻ do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not move card due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'DELETE_CARD' && aiResult.payload?.cardTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const cardTitleLower = String(aiResult.payload.cardTitle).trim().toLowerCase()
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || [])).find((c) => {
        const ct = c.title.toLowerCase()
        return ct === cardTitleLower || ct.includes(cardTitleLower) || cardTitleLower.includes(ct)
      })
      if (!card) throw new Error('Card not found in the current board')
      await cardService.deleteItem(card._id.toString(), userId)
      actionResult = { type: 'CARD_DELETED', data: { cardId: card._id.toString(), title: card.title } }
      aiResult.message += NEWLINE2 + (language === 'vi'
        ? `🗑️ Đã xóa vĩnh viễn thẻ "${card.title}".`
        : `🗑️ Card "${card.title}" was permanently deleted.`)
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể xóa thẻ do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not delete card due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'ADD_CARD_LABEL' && aiResult.payload?.cardTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const cardTitleLower = String(aiResult.payload.cardTitle).trim().toLowerCase()
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || [])).find((c) => {
        const ct = c.title.toLowerCase()
        return ct === cardTitleLower || ct.includes(cardTitleLower) || cardTitleLower.includes(ct)
      })
      if (!card) throw new Error('Card not found in the current board')

      let labelsToAdd = []
      if (Array.isArray(aiResult.payload.labels)) {
        labelsToAdd = aiResult.payload.labels.map(l => ({
          title: String(l.title || '').trim(),
          color: String(l.color || '#0052cc').trim()
        }))
      } else if (aiResult.payload.labelTitle || aiResult.payload.color) {
        labelsToAdd = [{
          title: String(aiResult.payload.labelTitle || '').trim(),
          color: String(aiResult.payload.color || '#0052cc').trim()
        }]
      }
      if (labelsToAdd.length === 0) throw new Error('No label data provided')

      const existing = card.labels || []
      const merged = [...existing]
      for (const l of labelsToAdd) {
        if (!merged.some(el => el.title === l.title && el.color === l.color)) {
          merged.push(l)
        }
      }

      await cardService.update(card._id.toString(), { labels: merged }, undefined, { _id: userId })
      actionResult = { type: 'CARD_LABEL_ADDED', data: { cardId: card._id.toString(), cardTitle: card.title, labels: merged } }
      aiResult.message += NEWLINE2 + (language === 'vi'
        ? `🏷️ Đã gắn nhãn (${labelsToAdd.map(l => l.title || l.color).join(', ')}) vào thẻ "${card.title}".`
        : `🏷️ Added label(s) (${labelsToAdd.map(l => l.title || l.color).join(', ')}) to card "${card.title}".`)
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thêm nhãn do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not add label due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'ADD_CHECKLIST' && aiResult.payload?.cardTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const cardTitleLower = String(aiResult.payload.cardTitle).trim().toLowerCase()
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || [])).find((c) => {
        const ct = c.title.toLowerCase()
        return ct === cardTitleLower || ct.includes(cardTitleLower) || cardTitleLower.includes(ct)
      })
      if (!card) throw new Error('Card not found in the current board')

      const clTitle = String(aiResult.payload.checklistTitle || (language === 'vi' ? 'Checklist công việc' : 'Checklist')).trim()
      const rawItems = Array.isArray(aiResult.payload.items) ? aiResult.payload.items : []
      const items = rawItems.map(it => {
        if (typeof it === 'string') {
          return { _id: randomUUID(), title: it.trim(), isDone: false, memberIds: [], attachments: [] }
        }
        return {
          _id: randomUUID(),
          title: String(it.title || '').trim(),
          isDone: Boolean(it.isDone),
          memberIds: [],
          attachments: []
        }
      }).filter(it => it.title)

      const newChecklist = {
        _id: randomUUID(),
        title: clTitle,
        memberIds: [],
        items
      }

      const updatedChecklists = [...(card.checklists || []), newChecklist]
      await cardService.update(card._id.toString(), { checklists: updatedChecklists }, undefined, { _id: userId })
      actionResult = { type: 'CHECKLIST_ADDED', data: { cardId: card._id.toString(), cardTitle: card.title, checklist: newChecklist } }
      aiResult.message += NEWLINE2 + (language === 'vi'
        ? `✅ Đã thêm checklist "${clTitle}" với ${items.length} mục vào thẻ "${card.title}".`
        : `✅ Added checklist "${clTitle}" with ${items.length} item(s) to card "${card.title}".`)
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thêm checklist do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not add checklist due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'CHECK_CHECKLIST_ITEM' && aiResult.payload?.cardTitle && aiResult.payload?.itemTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const cardTitleLower = String(aiResult.payload.cardTitle).trim().toLowerCase()
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || [])).find((c) => {
        const ct = c.title.toLowerCase()
        return ct === cardTitleLower || ct.includes(cardTitleLower) || cardTitleLower.includes(ct)
      })
      if (!card) throw new Error('Card not found in the current board')

      const targetItemName = String(aiResult.payload.itemTitle).trim().toLowerCase()
      const targetStatus = aiResult.payload.isDone !== false
      let found = false
      let foundTitle = ''

      const updatedChecklists = (card.checklists || []).map(cl => ({
        ...cl,
        items: (cl.items || []).map(it => {
          const itTitle = String(it.title || '').trim().toLowerCase()
          if (itTitle === targetItemName || itTitle.includes(targetItemName) || targetItemName.includes(itTitle)) {
            found = true
            foundTitle = it.title
            return { ...it, isDone: targetStatus }
          }
          return it
        })
      }))

      if (!found) throw new Error(`Subtask item "${aiResult.payload.itemTitle}" not found in card checklists`)

      await cardService.update(card._id.toString(), { checklists: updatedChecklists }, undefined, { _id: userId })
      actionResult = { type: 'CHECKLIST_ITEM_UPDATED', data: { cardId: card._id.toString(), cardTitle: card.title, itemTitle: foundTitle, isDone: targetStatus } }
      aiResult.message += NEWLINE2 + (language === 'vi'
        ? `✔️ Đã đánh dấu ${targetStatus ? 'hoàn thành' : 'chưa hoàn thành'} mục "${foundTitle}" trong thẻ "${card.title}".`
        : `✔️ Marked item "${foundTitle}" as ${targetStatus ? 'completed' : 'uncompleted'} in card "${card.title}".`)
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể cập nhật mục checklist do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not update checklist item due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'ADD_CARD_COMMENT' && aiResult.payload?.cardTitle && aiResult.payload?.content) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const cardTitleLower = String(aiResult.payload.cardTitle).trim().toLowerCase()
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || [])).find((c) => {
        const ct = c.title.toLowerCase()
        return ct === cardTitleLower || ct.includes(cardTitleLower) || cardTitleLower.includes(ct)
      })
      if (!card) throw new Error('Card not found in the current board')

      const commentContent = String(aiResult.payload.content).trim()
      if (!commentContent) throw new Error('Comment content is empty')

      const currentUser = await userModel.findOneById(userId)
      if (!currentUser) throw new Error('User not found')

      await cardService.update(card._id.toString(), { commentToAdd: { content: commentContent } }, undefined, currentUser)
      actionResult = { type: 'CARD_COMMENT_ADDED', data: { cardId: card._id.toString(), cardTitle: card.title, content: commentContent } }
      aiResult.message += NEWLINE2 + (language === 'vi'
        ? `💬 Đã thêm bình luận vào thẻ "${card.title}".`
        : `💬 Added comment to card "${card.title}".`)
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thêm bình luận do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not add comment due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'DELETE_SCHEDULE' && aiResult.payload?.scheduleTitle) {
    try {
      const rawTitle = String(aiResult.payload.scheduleTitle).trim()
      const regexPattern = escapeRegex(rawTitle)
      const entry = await GET_DB().collection('schedules').findOne({
        userId: new ObjectId(userId),
        _destroy: { $ne: true },
        title: { $regex: new RegExp(regexPattern, 'i') }
      })
      if (!entry) throw new Error(language === 'vi' ? 'Không tìm thấy lịch có tiêu đề tương ứng' : 'Schedule event not found')

      await scheduleService.deleteEntry(userId, entry._id.toString())
      actionResult = { type: 'SCHEDULE_DELETED', data: { _id: entry._id.toString(), title: entry.title } }
      aiResult.message += NEWLINE2 + (language === 'vi'
        ? `🗑️ Đã xóa sự kiện lịch "${entry.title}".`
        : `🗑️ Deleted schedule event "${entry.title}".`)
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể xóa lịch do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not delete schedule due to: ' + err.message + ')*'
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
