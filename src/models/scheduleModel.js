import Joi from 'joi'
import { ObjectId } from 'mongodb'
import { GET_DB } from '~/config/mongodb'
import { OBJECT_ID_RULE, OBJECT_ID_RULE_MESSAGE } from '~/utils/validators'
import { SCHEDULE_ENTRY_COLORS } from '~/utils/constants'

// Define Collection (name & schema)
const SCHEDULE_COLLECTION_NAME = 'schedules'

/**
 * Entry trong bảng lịch cá nhân của user ("giờ nào làm cái nào").
 * - startAt/endAt: epoch ms (Joi timestamp 'javascript' tự convert sang Date)
 * - colorKey: key màu hiển thị (map sang palette ở FE)
 * - cardId/boardId: optional - entry gắn với card của Kanflow (để biết khung giờ đó làm card gì)
 * - cardTitle/boardTitle: denormalize lúc gắn card để FE render nhanh không cần join
 */
const SCHEDULE_COLLECTION_SCHEMA = Joi.object({
  userId: Joi.string().required().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),

  title: Joi.string().required().min(1).max(120).trim().strict(),
  description: Joi.string().optional().allow('').max(2000).trim().strict(),

  startAt: Joi.date().timestamp('javascript').required(),
  endAt: Joi.date().timestamp('javascript').required(),

  colorKey: Joi.string().valid(...Object.values(SCHEDULE_ENTRY_COLORS)).default(SCHEDULE_ENTRY_COLORS.BLUE),

  cardId: Joi.string().optional().allow(null).pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
  boardId: Joi.string().optional().allow(null).pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
  cardTitle: Joi.string().optional().allow(null, '').max(200).trim().strict(),
  boardTitle: Joi.string().optional().allow(null, '').max(200).trim().strict(),

  createdAt: Joi.date().timestamp('javascript').default(Date.now),
  updatedAt: Joi.date().timestamp('javascript').default(null),
  _destroy: Joi.boolean().default(false)
})

// Chỉ định ra những Fields mà chúng ta không muốn cho phép cập nhật trong hàm update()
const INVALID_UPDATE_FIELDS = ['_id', 'userId', 'createdAt']

const validateBeforeCreate = async (data) => {
  return await SCHEDULE_COLLECTION_SCHEMA.validateAsync(data, { abortEarly: false })
}

const createNew = async (data) => {
  try {
    const validData = await validateBeforeCreate(data)

    // Biến đổi một số dữ liệu liên quan tới ObjectId chuẩn chỉnh
    const newEntryToAdd = {
      ...validData,
      userId: new ObjectId(validData.userId),
      cardId: validData.cardId ? new ObjectId(validData.cardId) : null,
      boardId: validData.boardId ? new ObjectId(validData.boardId) : null
    }

    const createdEntry = await GET_DB()
      .collection(SCHEDULE_COLLECTION_NAME)
      .insertOne(newEntryToAdd)

    return createdEntry
  } catch (error) {
    throw new Error(error)
  }
}

const findOneById = async (entryId) => {
  try {
    return await GET_DB()
      .collection(SCHEDULE_COLLECTION_NAME)
      .findOne({ _id: new ObjectId(entryId) })
  } catch (error) {
    throw new Error(error)
  }
}

/**
 * Các entry của 1 user giao với khoảng [from, to) - dùng cho view tuần/tháng.
 * Điều kiện overlap: startAt < to && endAt > from
 */
const findByUserInRange = async (userId, from, to) => {
  try {
    return await GET_DB().collection(SCHEDULE_COLLECTION_NAME).find({
      userId: new ObjectId(userId),
      _destroy: false,
      startAt: { $lt: new Date(to) },
      endAt: { $gt: new Date(from) }
    }).sort({ startAt: 1 }).toArray()
  } catch (error) {
    throw new Error(error)
  }
}

/**
 * Update entry - query luôn kèm userId để đảm bảo ownership ngay tại tầng DB
 * (user khác không thể sửa entry của nhau kể cả biết entryId)
 */
const update = async (entryId, userId, updateData, { session } = {}) => {
  try {
    // Lọc những field mà chúng ta không cho phép cập nhật linh tinh
    Object.keys(updateData).forEach(fieldName => {
      if (INVALID_UPDATE_FIELDS.includes(fieldName)) {
        delete updateData[fieldName]
      }
    })

    // Đối với những dữ liệu liên quan ObjectId, biến đổi ở đây
    if (updateData.cardId !== undefined) {
      updateData.cardId = updateData.cardId ? new ObjectId(updateData.cardId) : null
    }
    if (updateData.boardId !== undefined) {
      updateData.boardId = updateData.boardId ? new ObjectId(updateData.boardId) : null
    }

    const result = await GET_DB().collection(SCHEDULE_COLLECTION_NAME).findOneAndUpdate(
      { _id: new ObjectId(entryId), userId: new ObjectId(userId), _destroy: false },
      { $set: { ...updateData, updatedAt: Date.now() } },
      { returnDocument: 'after', session }
    )

    return result
  } catch (error) {
    throw new Error(error)
  }
}

/**
 * Soft delete entry (đánh dấu _destroy) - query kèm userId như update
 */
const softDelete = async (entryId, userId, { session } = {}) => {
  try {
    const result = await GET_DB().collection(SCHEDULE_COLLECTION_NAME).findOneAndUpdate(
      { _id: new ObjectId(entryId), userId: new ObjectId(userId), _destroy: false },
      { $set: { _destroy: true, updatedAt: Date.now() } },
      { returnDocument: 'after', session }
    )

    return result
  } catch (error) {
    throw new Error(error)
  }
}

export const scheduleModel = {
  SCHEDULE_COLLECTION_NAME,
  SCHEDULE_COLLECTION_SCHEMA,
  createNew,
  findOneById,
  findByUserInRange,
  update,
  softDelete
}
