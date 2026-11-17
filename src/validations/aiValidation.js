import Joi from 'joi'
import ApiError from '~/utils/ApiError'
import { StatusCodes } from 'http-status-codes'

const chat = async (req, res, next) => {
  const correctCondition = Joi.object({
    message: Joi.string().required().min(1).max(2000).trim(),
    history: Joi.array().items(
      Joi.object({
        role: Joi.string().valid('user', 'assistant', 'model').required(),
        content: Joi.string().allow('').required()
      })
    ).optional(),
    currentBoardId: Joi.string().allow('', null).optional(),
    language: Joi.string().valid('vi', 'en').default('vi').optional(),
    customApiKey: Joi.string().allow('', null).optional()
  })

  try {
    await correctCondition.validateAsync(req.body, { abortEarly: false })
    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

export const aiValidation = {
  chat
}
