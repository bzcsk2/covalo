import { useState, useCallback, useMemo } from "react"
import { Box, Text, useInput } from "@deepreef/ink"
import { PROVIDERS, resolveApiKey, saveProjectApiKey, deleteProjectApiKey, listConfiguredApiKeys } from "@deepreef/core"
import type { ApiKeySource } from "@deepreef/core"
import { buildMenuRows, getPrevSelectableIndex, getNextSelectableIndex, clampWindow, resolveLocalBaseUrl } from "./model-menu.js"
import type { ModelMenuRow, ModelSelection } from "./model-menu.js"
import { tryReadClipboard } from "./clipboard.js"
import { t } from "./i18n/index.js"

interface ModelPickerProps {
  currentProvider: string
  currentModel: string
  onSelect: (config: { provider: string; model: string; apiKey: string; baseUrl: string }) => void
  onCancel: () => void
}

type Step = "main" | "key" | "custom" | "delete-confirm"

const WINDOW_SIZE = 20

export function ModelPicker({ currentProvider, currentModel, onSelect, onCancel }: ModelPickerProps) {
  const [step, setStep] = useState<Step>("main")
  const [selIdx, setSelIdx] = useState(0)
  const [inputBuf, setInputBuf] = useState("")
  const [editField, setEditField] = useState(0)
  const [customUrl, setCustomUrl] = useState(resolveLocalBaseUrl())
  const [customModel, setCustomModel] = useState("")
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, ApiKeySource>>(() => listConfiguredApiKeys())
  const [pendingProvider, setPendingProvider] = useState("")
  const [keyUpdateMode, setKeyUpdateMode] = useState(false)

  const rows = useMemo(() =>
    buildMenuRows(configuredKeys, expandedProviders, currentProvider, currentModel),
    [configuredKeys, expandedProviders, currentProvider, currentModel],
  )

  const refreshKeys = useCallback(() => {
    setConfiguredKeys(listConfiguredApiKeys())
  }, [])

  const confirmSelection = useCallback((target: ModelSelection) => {
    const { value: apiKey } = resolveApiKey(target.provider)
    onSelect({
      provider: target.provider,
      model: target.model,
      apiKey,
      baseUrl: target.baseUrl,
    })
  }, [onSelect])

  const goBack = useCallback(() => {
    if (step === "main") {
      onCancel()
    } else if (step === "key") {
      setInputBuf("")
      setKeyUpdateMode(false)
      setPendingProvider("")
      setStep("main")
    } else if (step === "custom") {
      setInputBuf("")
      setEditField(0)
      setStep("main")
    } else if (step === "delete-confirm") {
      setPendingProvider("")
      setStep("main")
    }
  }, [step, onCancel])

  useInput((_input, key) => {
    const escOrCtrlC = key.escape || (key.ctrl && _input === "c")

    if (step === "main") {
      if (escOrCtrlC) {
        onCancel()
        return
      }

      if (key.upArrow) {
        setSelIdx(prev => getPrevSelectableIndex(rows, prev))
        return
      }
      if (key.downArrow) {
        setSelIdx(prev => getNextSelectableIndex(rows, prev))
        return
      }

      // e: update key for configured provider
      if (_input === "e" || _input === "E") {
        const row = rows[selIdx]
        if (row?.kind === "provider" && row.configured) {
          setPendingProvider(row.provider)
          setInputBuf("")
          setKeyUpdateMode(true)
          setStep("key")
        }
        return
      }

      // d: delete key for configured provider
      if (_input === "d" || _input === "D") {
        const row = rows[selIdx]
        if (row?.kind === "provider" && row.configured && row.keySource === "project-file") {
          setPendingProvider(row.provider)
          setStep("delete-confirm")
        }
        return
      }

      if (key.return) {
        const row = rows[selIdx]
        if (!row) return

        if (row.kind === "provider") {
          if (!row.configured) {
            setPendingProvider(row.provider)
            setInputBuf("")
            setKeyUpdateMode(false)
            setStep("key")
          } else {
            if (expandedProviders.has(row.provider)) {
              const next = new Set(expandedProviders)
              next.delete(row.provider)
              setExpandedProviders(next)
            } else {
              setExpandedProviders(prev => new Set(prev).add(row.provider))
            }
          }
          return
        }

        if (row.kind === "model") {
          confirmSelection(row.target)
          return
        }

        if (row.kind === "custom") {
          setInputBuf(customUrl)
          setEditField(0)
          setStep("custom")
          return
        }
      }
      return
    }

    if (step === "key") {
      if (escOrCtrlC) {
        goBack()
        return
      }
      if (key.return && inputBuf.length > 0) {
        saveProjectApiKey(pendingProvider, inputBuf)
        setInputBuf("")
        setExpandedProviders(prev => new Set(prev).add(pendingProvider))
        refreshKeys()
        setPendingProvider("")
        setKeyUpdateMode(false)
        setStep("main")
        return
      }
      if (key.backspace || key.delete) {
        setInputBuf(prev => prev.slice(0, -1))
        return
      }
      if (key.ctrl && (_input === "v" || _input === "V")) {
        void tryReadClipboard().then(clip => {
          if (clip) setInputBuf(prev => prev + clip)
        })
        return
      }
      if (_input) {
        setInputBuf(prev => prev + _input)
      }
      return
    }

    if (step === "custom") {
      if (escOrCtrlC) {
        goBack()
        return
      }
      if (key.return && inputBuf.length > 0) {
        if (editField === 0) {
          setCustomUrl(inputBuf)
          setEditField(1)
          setInputBuf(customModel)
          return
        } else {
          setCustomModel(inputBuf)
          setEditField(0)
          onSelect({
            provider: "openai-compatible",
            model: inputBuf,
            apiKey: "",
            baseUrl: customUrl,
          })
          return
        }
      }
      if (key.backspace || key.delete) {
        setInputBuf(prev => prev.slice(0, -1))
        return
      }
      if (key.ctrl && (_input === "v" || _input === "V")) {
        void tryReadClipboard().then(clip => {
          if (clip) setInputBuf(prev => prev + clip)
        })
        return
      }
      if (_input) {
        setInputBuf(prev => prev + _input)
      }
      return
    }

    if (step === "delete-confirm") {
      if (escOrCtrlC) {
        setPendingProvider("")
        setStep("main")
        return
      }
      if (_input === "y" || _input === "Y") {
        deleteProjectApiKey(pendingProvider)
        setExpandedProviders(prev => {
          const next = new Set(prev)
          next.delete(pendingProvider)
          return next
        })
        refreshKeys()
        setPendingProvider("")
        setStep("main")
        return
      }
      return
    }
  })

  const scrollStart = useMemo(
    () => clampWindow(selIdx, rows.length, WINDOW_SIZE),
    [selIdx, rows.length],
  )
  const visibleRows = useMemo(
    () => rows.slice(scrollStart, scrollStart + WINDOW_SIZE),
    [rows, scrollStart],
  )

  const renderRow = (row: ModelMenuRow, globalIdx: number) => {
    if (row.kind === "header") {
      return (
        <Box key={row.id}>
          <Text bold underline>{row.label}</Text>
        </Box>
      )
    }

    const isSelected = globalIdx === selIdx
    const selChar = isSelected ? "❯ " : "  "

    if (row.kind === "provider") {
      let tag = ""
      if (row.configured) {
        const keyTag = row.keySource === "env" ? t().keySourceEnv
          : row.keySource === "project-file" ? t().keySourceFile
          : row.keySource === "default" ? t().keySourceDefault
          : ""
        tag = `${t().configured}${keyTag}`
      } else {
        tag = t().yourApiKey
      }
      return (
        <Box key={row.id}>
          <Text>{selChar}</Text>
          <Text bold={isSelected}>{row.label}</Text>
          <Text dimColor>  {tag}</Text>
          {isSelected && row.configured && (
            <Text dimColor>{t().pressEToEdit}{t().pressDToDelete}</Text>
          )}
        </Box>
      )
    }

    const isCurrent = row.kind === "model" && row.target.provider === currentProvider && row.target.model === currentModel

    if (row.kind === "custom") {
      return (
        <Box key={row.id}>
          <Text>{selChar}</Text>
          <Text bold={isSelected}>{row.label}</Text>
        </Box>
      )
    }

    if (row.kind === "model") {
      return (
        <Box key={row.id} paddingLeft={2}>
          <Text>{selChar}</Text>
          <Text bold={isSelected}>{row.label}</Text>
          {isCurrent && <Text dimColor>{t().current}</Text>}
        </Box>
      )
    }

    return null
  }

  const maskKey = (raw: string): string => {
    if (raw.length <= 8) return "****"
    const suffix = raw.slice(-4)
    return t().apiKeyMasked(suffix)
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} borderStyle="round" width="100%">
      <Box marginBottom={1}>
        <Text bold>{t().modelSettings}</Text>
      </Box>

      {step === "main" && (
        <Box flexDirection="column">
          {visibleRows.map((row, i) => renderRow(row, scrollStart + i))}
          <Text dimColor>{t().escToGoBack}</Text>
        </Box>
      )}

      {step === "key" && (
        <Box flexDirection="column">
          <Text dimColor>
            {keyUpdateMode ? t().updateKey : t().enterApiKey(PROVIDERS[pendingProvider]?.label ?? pendingProvider)}
          </Text>
          <Text>  {maskKey(inputBuf)}{inputBuf.length > 0 ? "▊" : ""}</Text>
          <Text dimColor>{t().escToGoBack}</Text>
        </Box>
      )}

      {step === "custom" && (
        <Box flexDirection="column">
          <Text dimColor>{t().modelCustomConfigure}</Text>
          <Box marginTop={1}>
            <Text bold={editField === 0}>❯ </Text>
            <Text dimColor>{t().modelCustomBaseUrl} </Text>
            <Text>{editField === 0 ? `${inputBuf}${inputBuf.length > 0 ? "▊" : ""}` : customUrl}</Text>
          </Box>
          <Box>
            <Text bold={editField === 1}>❯ </Text>
            <Text dimColor>{t().modelCustomModel} </Text>
            <Text>{editField === 1 ? `${inputBuf}${inputBuf.length > 0 ? "▊" : ""}` : customModel || t().modelCustomPlaceholder}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{t().escToGoBack}</Text>
          </Box>
        </Box>
      )}

      {step === "delete-confirm" && (
        <Box flexDirection="column">
          <Text dimColor>{t().confirmDelete}</Text>
          <Text>{t().pressYToConfirm}</Text>
        </Box>
      )}
    </Box>
  )
}
