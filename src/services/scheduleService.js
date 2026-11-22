import { StatusCodes } from 'http-status-codes'
import ApiError from '~/utils/ApiError'
import { scheduleModel } from '~/models/scheduleModel'
import { authorizationService } from '~/services/authorizationService'
import { SCHEDULE_ACTION_TYPES, emitScheduleChangeToUser } from '~/sockets/scheduleSocket'
import { SCHEDULE_ENTRY_COLORS } from '~/utils/constants'

// 1 entry lịch không vượt quá 24 giờ (kiểm tra lại sau khi merge thời gian mới/cũ khi update)
const MAX_ENTRY_SPAN_MS = 24 * 60 * 60 * 1000

/**
 * Kiểm tra user có quyền truy cập board mà entry gắn vào (chống IDOR qua cardId/boardId)
 */
const assertCardAttachable = async (userId, cardId, boardId) => {
  if (!cardId && !boardId) return

  const targetBoardId = boardId
  if (targetBoardId) {
    await authorizationService.requireBoardAccess(userId, targetBoardId)
  }
}

const createNewEntry = async (reqBody, userId) => {
  try {
    // Nếu entry gắn card/board thì user phải là owner/member của board đó
    await assertCardAttachable(userId, reqBody.cardId, reqBody.boardId)

    const newEntryData = {
      userId: userId.toString(),
      title: reqBody.title,
      description: reqBody.description || '',
      startAt: reqBody.startAt,
      endAt: reqBody.endAt,
      colorKey: reqBody.colorKey || SCHEDULE_ENTRY_COLORS.BLUE,
      cardId: reqBody.cardId || null,
      boardId: reqBody.boardId || null,
      cardTitle: reqBody.cardTitle || null,
      boardTitle: reqBody.boardTitle || null
    }

    const createdEntry = await scheduleModel.createNew(newEntryData)
    const getEntry = await scheduleModel.findOneById(createdEntry.insertedId)

    // Đẩy thay đổi tới mọi thiết bị của user
    emitScheduleChangeToUser(userId, { actionType: SCHEDULE_ACTION_TYPES.CREATE, entry: getEntry })

    return getEntry
  } catch (error) {
    throw error
  }
}

const getEntriesInRange = async (userId, from, to) => {
  try {
    return await scheduleModel.findByUserInRange(userId, from, to)
  } catch (error) {
    throw error
  }
}

const updateEntry = async (userId, entryId, reqBody) => {
  try {
    // Nếu entry gắn card/board thì user phải là owner/member của board đó
    await assertCardAttachable(userId, reqBody.cardId, reqBody.boardId)

    const existingEntry = await scheduleModel.findOneById(entryId)
    if (!existingEntry || existingEntry.userId.toString() !== userId.toString()) {
      // 404 thay vì 403 để không lộ sự tồn tại của entry người khác
      throw new ApiError(StatusCodes.NOT_FOUND, 'Schedule entry not found!')
    }

    // Merge thời gian (update có thể chỉ gửi 1 mốc) rồi kiểm tra lại bất biến
    const startAt = reqBody.startAt !== undefined ? reqBody.startAt : existingEntry.startAt.valueOf()
    const endAt = reqBody.endAt !== undefined ? reqBody.endAt : existingEntry.endAt.valueOf()

    if (endAt <= startAt) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'endAt must be greater than startAt!')
    }
    if (endAt - startAt > MAX_ENTRY_SPAN_MS) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'A schedule entry cannot span more than 24 hours!')
    }

    const updatedEntry = await scheduleModel.update(entryId, userId, {
      ...reqBody,
      startAt,
      endAt
    })

    if (!updatedEntry) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'Schedule entry not found!')
    }

    emitScheduleChangeToUser(userId, { actionType: SCHEDULE_ACTION_TYPES.UPDATE, entry: updatedEntry })

    return updatedEntry
  } catch (error) {
    throw error
  }
}

const deleteEntry = async (userId, entryId) => {
  try {
    const deletedEntry = await scheduleModel.softDelete(entryId, userId)

    if (!deletedEntry) {
      // 404 thay vì 403 để không lộ sự tồn tại của entry người khác
      throw new ApiError(StatusCodes.NOT_FOUND, 'Schedule entry not found!')
    }

    emitScheduleChangeToUser(userId, { actionType: SCHEDULE_ACTION_TYPES.DELETE, entry: deletedEntry })

    return deletedEntry
  } catch (error) {
    throw error
  }
}

export const scheduleService = {
  createNewEntry,
  getEntriesInRange,
  updateEntry,
  deleteEntry
}
