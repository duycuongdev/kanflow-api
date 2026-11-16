import Joi from 'joi'
import { StatusCodes } from 'http-status-codes'
import ApiError from '~/utils/ApiError'
import { OBJECT_ID_RULE, OBJECT_ID_RULE_MESSAGE } from '~/utils/validators'

const createNew = async (req, res, next) => {
  const correctCondition = Joi.object({
    title: Joi.string().required().min(3).max(50).trim().strict().messages({
      'any.required': 'Title is required',
      'string.empty': 'Title is not allowed to be empty',
      'string.min': 'Title length must be at 3 character long',
      'string.max': 'Title length must be less than or equal to 5 character long',
      'string.trim': 'Title must not have leading or trailing whitespace'
    }),
    description: Joi.string().optional().allow('').max(256).trim().default(''),
    template: Joi.string().valid('kanban', 'blank').optional()
  })

  try {
    await correctCondition.validateAsync(req.body, { abortEarly: false })
    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

const update = async (req, res, next) => {
  const correctCondition = Joi.object({
    title: Joi.string().min(3).max(50).trim().strict(),
    description: Joi.string().min(3).max(256).trim().strict(),
    background: Joi.string().allow(null, '').optional(),
    columnOrderIds: Joi.array().items(
      Joi.string().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE)
    )
  })

  try {
    await correctCondition.validateAsync(req.body, {
      abortEarly: false,
      allowUnknown: true
    })
    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

const moveCardToDifferentColumn = async (req, res, next) => {
  const correctCondition = Joi.object({
    currentCardId: Joi.string().required().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),

    prevColumnId: Joi.string().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
    prevCardOrderIds: Joi.array().required().items(
      Joi.string().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE)
    ),

    nextColumnId: Joi.string().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
    nextCardOrderIds: Joi.array().required().items(
      Joi.string().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE)
    )
  })

  try {
    await correctCondition.validateAsync(req.body, { abortEarly: false })
    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

const removeMember = async (req, res, next) => {
  const correctCondition = Joi.object({
    boardId: Joi.string().required().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
    userId: Joi.string().required().pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE)
  })

  try {
    await correctCondition.validateAsync(req.params, { abortEarly: false })
    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

const importBoard = async (req, res, next) => {
  const correctCondition = Joi.object({
    title: Joi.string().required().min(1).max(100).trim().strict(),
    description: Joi.string().optional().allow('').max(500).default(''),
    exportedAt: Joi.string().optional(),
    version: Joi.string().optional(),
    columns: Joi.array().items(
      Joi.object({
        title: Joi.string().required().trim(),
        cards: Joi.array().items(
          Joi.object({
            title: Joi.string().required().trim(),
            description: Joi.string().optional().allow(''),
            dueDate: Joi.date().timestamp('javascript').allow(null).optional(),
            isDueDateComplete: Joi.boolean().optional(),
            labels: Joi.array().items(
              Joi.object({
                title: Joi.string().allow('').optional(),
                color: Joi.string().required()
              })
            ).optional(),
            checklists: Joi.array().items(
              Joi.object({
                title: Joi.string().required().trim(),
                items: Joi.array().items(
                  Joi.object({
                    title: Joi.string().required().trim(),
                    isDone: Joi.boolean().optional()
                  }).unknown(true)
                ).optional()
              }).unknown(true)
            ).optional()
          }).unknown(true)
        ).optional()
      }).unknown(true)
    ).optional().default([])
  }).unknown(true)

  try {
    await correctCondition.validateAsync(req.body, { abortEarly: false })
    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

export const boardValidation = {
  createNew,
  importBoard,
  update,
  moveCardToDifferentColumn,
  removeMember
}
