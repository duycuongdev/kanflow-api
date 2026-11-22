import Joi from 'joi'
import { StatusCodes } from 'http-status-codes'
import ApiError from '~/utils/ApiError'
import { OBJECT_ID_RULE, OBJECT_ID_RULE_MESSAGE } from '~/utils/validators'
import { SCHEDULE_ENTRY_COLORS } from '~/utils/constants'

// 1 entry lịch không vượt quá 24 giờ
const MAX_ENTRY_SPAN_MS = 24 * 60 * 60 * 1000

// Query range tối đa 400 ngày (đủ cho cả view năm)
const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000

const createNew = async (req, res, next) => {
  const correctCondition = Joi.object({
    title: Joi.string().required().min(1).max(120).trim().strict().messages({
      'string.empty': 'Title is required',
      'string.max': 'Title must be at most 120 characters'
    }),
    description: Joi.string().optional().allow('').max(2000).trim().strict(),
    startAt: Joi.number().integer().required(),
    endAt: Joi.number().integer().required(),
    colorKey: Joi.string().optional().valid(...Object.values(SCHEDULE_ENTRY_COLORS)),
    cardId: Joi.string().optional().allow(null).pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
    boardId: Joi.string().optional().allow(null).pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
    cardTitle: Joi.string().optional().allow(null, '').max(200).trim().strict(),
    boardTitle: Joi.string().optional().allow(null, '').max(200).trim().strict(),
    // checklist/item dùng UUID phía FE (không phải ObjectId) nên chỉ giới hạn độ dài
    checklistId: Joi.string().optional().allow(null, '').max(64).trim().strict(),
    checklistItemId: Joi.string().optional().allow(null, '').max(64).trim().strict(),
    checklistTitle: Joi.string().optional().allow(null, '').max(200).trim().strict(),
    itemTitle: Joi.string().optional().allow(null, '').max(200).trim().strict()
  })

  try {
    const body = await correctCondition.validateAsync(req.body, { abortEarly: false })

    if (body.endAt <= body.startAt) {
      throw new Error('endAt must be greater than startAt')
    }
    if (body.endAt - body.startAt > MAX_ENTRY_SPAN_MS) {
      throw new Error('A schedule entry cannot span more than 24 hours')
    }
    if (body.cardId && !body.boardId) {
      throw new Error('boardId is required when attaching a card')
    }

    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

const updateEntry = async (req, res, next) => {
  const paramCondition = Joi.object({
    entryId: Joi.string().required().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE)
  })

  const bodyCondition = Joi.object({
    title: Joi.string().optional().min(1).max(120).trim().strict(),
    description: Joi.string().optional().allow('').max(2000).trim().strict(),
    startAt: Joi.number().integer().optional(),
    endAt: Joi.number().integer().optional(),
    colorKey: Joi.string().optional().valid(...Object.values(SCHEDULE_ENTRY_COLORS)),
    cardId: Joi.string().optional().allow(null).pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
    boardId: Joi.string().optional().allow(null).pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
    cardTitle: Joi.string().optional().allow(null, '').max(200).trim().strict(),
    boardTitle: Joi.string().optional().allow(null, '').max(200).trim().strict(),
    checklistId: Joi.string().optional().allow(null, '').max(64).trim().strict(),
    checklistItemId: Joi.string().optional().allow(null, '').max(64).trim().strict(),
    checklistTitle: Joi.string().optional().allow(null, '').max(200).trim().strict(),
    itemTitle: Joi.string().optional().allow(null, '').max(200).trim().strict()
  }).min(1)

  try {
    await paramCondition.validateAsync(req.params, { abortEarly: false })
    const body = await bodyCondition.validateAsync(req.body, { abortEarly: false })

    // Nếu update cả 2 mốc thời gian thì kiểm tra ngay; nếu chỉ update 1 mốc thì service sẽ merge với dữ liệu cũ rồi kiểm tra lại
    if (body.startAt !== undefined && body.endAt !== undefined) {
      if (body.endAt <= body.startAt) {
        throw new Error('endAt must be greater than startAt')
      }
      if (body.endAt - body.startAt > MAX_ENTRY_SPAN_MS) {
        throw new Error('A schedule entry cannot span more than 24 hours')
      }
    }

    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

const deleteEntry = async (req, res, next) => {
  const paramCondition = Joi.object({
    entryId: Joi.string().required().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE)
  })

  try {
    await paramCondition.validateAsync(req.params, { abortEarly: false })
    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

const rangeQuery = async (req, res, next) => {
  const queryCondition = Joi.object({
    from: Joi.number().integer().required(),
    to: Joi.number().integer().required()
  })

  try {
    const query = await queryCondition.validateAsync(req.query, { abortEarly: false })

    if (query.to <= query.from) {
      throw new Error('"to" must be greater than "from"')
    }
    if (query.to - query.from > MAX_RANGE_MS) {
      throw new Error('Date range cannot exceed 400 days')
    }

    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

export const scheduleValidation = {
  createNew,
  updateEntry,
  deleteEntry,
  rangeQuery
}
