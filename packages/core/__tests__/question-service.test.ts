/**
 * QuestionService tests — adapted from OpenCode (MIT License).
 */

import { describe, it, expect } from 'vitest'
import { QuestionService } from '../src/question/service.js'
import { createQuestionId } from '../src/question/id.js'
import type { QuestionInfo } from '../src/question/types.js'

describe('QuestionService', () => {
  describe('ask', () => {
    it('creates pending question and returns promise', () => {
      const svc = new QuestionService()
      const questions: QuestionInfo[] = [
        { question: 'Pick one', header: 'Choice', options: [{ label: 'A', description: 'Option A' }] }
      ]
      const promise = svc.ask({ sessionId: 'sess1', questions, tool: { toolCallId: 'tc1', toolName: 'test' } })
      expect(typeof promise.then).toBe('function')

      const pending = svc.list()
      expect(pending).toHaveLength(1)
      expect(pending[0].sessionId).toBe('sess1')
      expect(pending[0].questions).toHaveLength(1)
    })

    it('generates unique que IDs', () => {
      const id1 = createQuestionId()
      const id2 = createQuestionId()
      expect(id1).not.toBe(id2)
      expect(id1).toMatch(/^que/)
    })

    it('WF-1: 支持外部传入 requestId', () => {
      const svc = new QuestionService()
      const questions: QuestionInfo[] = [
        { question: 'Pick one', header: 'Choice', options: [{ label: 'A', description: 'Option A' }] }
      ]
      const externalId = 'wf-ask-user-1234'
      svc.ask({ sessionId: 'sess1', questions, requestId: externalId })

      const pending = svc.list()
      expect(pending).toHaveLength(1)
      expect(pending[0].id).toBe(externalId)
    })

    it('WF-1: 外部 requestId 可用于 reply', async () => {
      const svc = new QuestionService()
      const questions: QuestionInfo[] = [
        { question: 'Pick one', header: 'Choice', options: [{ label: 'A', description: 'Option A' }] }
      ]
      const externalId = 'wf-ask-user-5678'
      const promise = svc.ask({ sessionId: 'sess1', questions, requestId: externalId })

      setTimeout(() => {
        svc.reply({ requestId: externalId, answers: [['A']] })
      }, 0)

      const answers = await promise
      expect(answers).toEqual([['A']])
      expect(svc.list()).toHaveLength(0)
    })
  })

  describe('reply', () => {
    it('resolves promise with answers', async () => {
      const svc = new QuestionService()
      const questions: QuestionInfo[] = [
        { question: 'Pick one', header: 'Choice', options: [{ label: 'A', description: 'Option A' }] }
      ]
      const promise = svc.ask({ sessionId: 'sess1', questions })
      const req = svc.list()[0]

      // Reply in next microtask
      setTimeout(() => {
        svc.reply({ requestId: req.id, answers: [['A']] })
      }, 0)

      const answers = await promise
      expect(answers).toEqual([['A']])
      expect(svc.list()).toHaveLength(0)
    })

    it('throws for unknown request ID', () => {
      const svc = new QuestionService()
      expect(() => svc.reply({ requestId: 'unknown', answers: [['A']] })).toThrow('Question not found')
    })
  })

  describe('reject', () => {
    it('rejects promise with error', async () => {
      const svc = new QuestionService()
      const questions: QuestionInfo[] = [
        { question: 'Pick one', header: 'Choice', options: [{ label: 'A', description: 'Option A' }] }
      ]
      const promise = svc.ask({ sessionId: 'sess1', questions })
      const req = svc.list()[0]

      svc.reject(req.id)

      await expect(promise).rejects.toThrow('dismissed')
      expect(svc.list()).toHaveLength(0)
    })

    it('rejects unknown request ID', () => {
      const svc = new QuestionService()
      // Should throw for unknown request
      expect(() => svc.reject('unknown')).toThrow('Question not found')
    })
  })

  describe('interrupt', () => {
    it('rejects all pending questions', async () => {
      const svc = new QuestionService()
      const questions: QuestionInfo[] = [
        { question: 'Q1', header: 'H1', options: [{ label: 'A', description: 'Option A' }] }
      ]
      const promise1 = svc.ask({ sessionId: 'sess1', questions })
      const promise2 = svc.ask({ sessionId: 'sess1', questions })
      const promise3 = svc.ask({ sessionId: 'sess2', questions })

      // Catch unhandled rejections
      promise1.catch(() => {})
      promise2.catch(() => {})
      promise3.catch(() => {})

      svc.interrupt()

      await expect(promise1).rejects.toThrow('dismissed')
      await expect(promise2).rejects.toThrow('dismissed')
      await expect(promise3).rejects.toThrow('dismissed')
      expect(svc.list()).toHaveLength(0)
    })
  })

  describe('shutdown', () => {
    it('clears everything', async () => {
      const svc = new QuestionService()
      const questions: QuestionInfo[] = [
        { question: 'Q1', header: 'H1', options: [{ label: 'A', description: 'Option A' }] }
      ]
      const promise1 = svc.ask({ sessionId: 'sess1', questions })
      const promise2 = svc.ask({ sessionId: 'sess2', questions })

      // Catch unhandled rejections
      promise1.catch(() => {})
      promise2.catch(() => {})

      svc.shutdown()

      await expect(promise1).rejects.toThrow('dismissed')
      await expect(promise2).rejects.toThrow('dismissed')
      expect(svc.list()).toHaveLength(0)
    })
  })

  describe('list', () => {
    it('returns all pending questions', () => {
      const svc = new QuestionService()
      const questions: QuestionInfo[] = [
        { question: 'Q1', header: 'H1', options: [{ label: 'A', description: 'Option A' }] }
      ]
      svc.ask({ sessionId: 'sess1', questions })
      svc.ask({ sessionId: 'sess2', questions })

      expect(svc.list()).toHaveLength(2)
    })

    it('returns empty when no pending', () => {
      const svc = new QuestionService()
      expect(svc.list()).toHaveLength(0)
    })
  })
})
