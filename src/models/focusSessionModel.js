import Joi from 'joi'
import { ObjectId } from 'mongodb'
import { GET_DB } from '~/config/mongodb'
import { OBJECT_ID_RULE, OBJECT_ID_RULE_MESSAGE } from '~/utils/validators'

// Define Collection (name & schema)
const FOCUS_SESSION_COLLECTION_NAME = 'focus_sessions'

/**
 * Phiên focus (đếm ngược tập trung) của user - dùng cho thống kê năng suất + bảng xếp hạng.
 * - startedAt/endedAt: epoch ms (Joi timestamp 'javascript' tự convert sang Date)
 * - durationMs: được tính ở tầng service (endedAt - startedAt), KHÔNG nhận từ client
 * - cardId/boardId: optional - phiên focus đang gắn với card/board nào (để mở rộng thống kê sau này)
 * - Phiên focus là dữ liệu "append-only": chỉ tạo, không cho sửa/xóa qua API
 */
const FOCUS_SESSION_COLLECTION_SCHEMA = Joi.object({
  userId: Joi.string().required().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),

  startedAt: Joi.date().timestamp('javascript').required(),
  endedAt: Joi.date().timestamp('javascript').required(),
  durationMs: Joi.number().integer().min(0).required(),

  cardId: Joi.string().optional().allow(null).pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
  boardId: Joi.string().optional().allow(null).pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),

  createdAt: Joi.date().timestamp('javascript').default(Date.now),
  _destroy: Joi.boolean().default(false)
})

const validateBeforeCreate = async (data) => {
  return await FOCUS_SESSION_COLLECTION_SCHEMA.validateAsync(data, { abortEarly: false })
}

const createNew = async (data) => {
  try {
    const validData = await validateBeforeCreate(data)

    // Biến đổi một số dữ liệu liên quan tới ObjectId chuẩn chỉnh
    const newSessionToAdd = {
      ...validData,
      userId: new ObjectId(validData.userId),
      cardId: validData.cardId ? new ObjectId(validData.cardId) : null,
      boardId: validData.boardId ? new ObjectId(validData.boardId) : null
    }

    const createdSession = await GET_DB()
      .collection(FOCUS_SESSION_COLLECTION_NAME)
      .insertOne(newSessionToAdd)

    return createdSession
  } catch (error) {
    throw new Error(error)
  }
}

const findOneById = async (sessionId) => {
  try {
    return await GET_DB()
      .collection(FOCUS_SESSION_COLLECTION_NAME)
      .findOne({ _id: new ObjectId(sessionId) })
  } catch (error) {
    throw new Error(error)
  }
}

/**
 * Tổng thời gian focus + số phiên của 1 user trong khoảng [from, to) (epoch ms)
 */
const sumDurationsByUserInRange = async (userId, from, to) => {
  try {
    const results = await GET_DB().collection(FOCUS_SESSION_COLLECTION_NAME).aggregate([
      { $match: {
        userId: new ObjectId(userId),
        _destroy: false,
        startedAt: { $gte: new Date(from), $lt: new Date(to) }
      } },
      { $group: {
        _id: null,
        totalMs: { $sum: '$durationMs' },
        sessionCount: { $sum: 1 }
      } }
    ]).toArray()

    return results[0] || { totalMs: 0, sessionCount: 0 }
  } catch (error) {
    throw new Error(error)
  }
}

/**
 * Bảng xếp hạng: tổng durationMs theo userId trong khoảng [from, to), sắp xếp giảm dần.
 * Trả về mảng { userId, totalMs, sessionCount } (chưa join user - việc join ở tầng service/model caller)
 */
const getTotalMsPerUserInRange = async (from, to) => {
  try {
    return await GET_DB().collection(FOCUS_SESSION_COLLECTION_NAME).aggregate([
      { $match: {
        _destroy: false,
        startedAt: { $gte: new Date(from), $lt: new Date(to) }
      } },
      { $group: {
        _id: '$userId',
        totalMs: { $sum: '$durationMs' },
        sessionCount: { $sum: 1 }
      } },
      { $sort: { totalMs: -1 } }
    ]).toArray()
  } catch (error) {
    throw new Error(error)
  }
}

export const focusSessionModel = {
  FOCUS_SESSION_COLLECTION_NAME,
  FOCUS_SESSION_COLLECTION_SCHEMA,
  createNew,
  findOneById,
  sumDurationsByUserInRange,
  getTotalMsPerUserInRange
}
