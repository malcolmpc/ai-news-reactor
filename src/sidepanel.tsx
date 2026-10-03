/// <reference types="chrome" />
import { CreateMLCEngine, type MLCEngine } from "@mlc-ai/web-llm"
import { useState } from "react"

type Headline = {
  id: number
  text: string
  x: number
  y: number
  href: string
}

type CursorPoint = {
  x: number
  y: number
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const localModelId = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC"
let localEnginePromise: Promise<MLCEngine> | undefined

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

async function getLocalEngine(onProgress: (message: string) => void): Promise<MLCEngine> {
  if (!(navigator as Navigator & { gpu?: unknown }).gpu) {
    throw new Error("Local AI requires a browser with WebGPU support.")
  }
  if (!localEnginePromise) {
    localEnginePromise = CreateMLCEngine(localModelId, {
      initProgressCallback: ({ text }) => onProgress(text)
    })
  }
  try {
    return await localEnginePromise
  } catch (error) {
    localEnginePromise = undefined
    throw error
  }
}

async function smoothScrollPage(tabId: number): Promise<boolean> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      window.scrollBy({ top: 300, behavior: "smooth" })
      await new Promise((resolve) => setTimeout(resolve, 500))
      return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4
    }
  })
  return Boolean(results[0]?.result)
}

async function extractVisibleHeadlines(tabId: number, seenHrefs: string[], firstId: number, limit: number) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [seenHrefs, firstId, limit],
    func: (excludedHrefs, idStart, maxItems) => {
      const semanticAnchors = Array.from(document.querySelectorAll("a h1, a h2, a h3, article a, main a"))
        .map((element) => element.closest("a"))
        .filter((anchor): anchor is HTMLAnchorElement => anchor instanceof HTMLAnchorElement)
      const anchors = Array.from(new Set([...semanticAnchors, ...document.querySelectorAll("a[href]")]))

      const headlines = anchors
        .map((anchor) => {
          const rect = anchor.getBoundingClientRect()
          const style = getComputedStyle(anchor)
          const text = (anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim()
          const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight &&
            rect.right > 0 && rect.left < innerWidth && style.visibility !== "hidden" && style.display !== "none"
          return { text, href: anchor.href, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, visible }
        })
        .filter((item) => item.visible && item.text.length >= 15 && !excludedHrefs.includes(item.href))
        .slice(0, maxItems)
        .map((item, index) => ({ id: idStart + index, text: item.text.slice(0, 180), x: item.x, y: item.y, href: item.href }))

      return {
        headlines,
        atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4
      }
    }
  })

  return (results[0]?.result ?? { headlines: [], atBottom: true }) as { headlines: Headline[]; atBottom: boolean }
}

async function scrollHeadlineIntoView(tabId: number, href: string): Promise<CursorPoint | undefined> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [href],
    func: async (targetHref) => {
      const anchor = Array.from(document.querySelectorAll("a[href]"))
        .find((element) => element.href === targetHref && element.innerText.trim())
      if (!anchor) return undefined
      anchor.scrollIntoView({ behavior: "smooth", block: "center" })
      await new Promise((resolve) => setTimeout(resolve, 600))
      const rect = anchor.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
  })

  return results[0]?.result as CursorPoint | undefined
}

async function ensureVirtualCursor(tabId: number): Promise<CursorPoint> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      let cursor = document.getElementById("ai-reactor-cursor")
      if (!cursor) {
        cursor = document.createElement("div")
        cursor.id = "ai-reactor-cursor"
        cursor.style.cssText = "position:fixed;left:50%;top:80%;width:14px;height:14px;border:2px solid white;border-radius:50%;background:#e53935;box-shadow:0 1px 8px #0008;z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%)"
        document.documentElement.appendChild(cursor)
      }
      const rect = cursor.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
  })

  return (results[0]?.result ?? { x: 0, y: 0 }) as CursorPoint
}

async function animateCursorToTarget(tabId: number, start: CursorPoint, target: CursorPoint) {
  for (let step = 1; step <= 25; step += 1) {
    const progress = step / 25
    const point = {
      x: start.x + (target.x - start.x) * progress,
      y: start.y + (target.y - start.y) * progress
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [point],
      func: (position) => {
        const cursor = document.getElementById("ai-reactor-cursor")
        if (cursor) {
          cursor.style.left = `${position.x}px`
          cursor.style.top = `${position.y}px`
        }
      }
    })
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y
    })
    await delay(24)
  }
}

function waitForNavigation(tabId: number, originalUrl: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    let changed = false
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutTimer = setTimeout(() => finish(false), 15000)
    const finish = (loaded: boolean) => {
      clearTimeout(timeoutTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve(loaded)
    }
    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId) return
      if (changeInfo.url && changeInfo.url !== originalUrl) changed = true
      if (!changed) return
      if (changeInfo.status === "complete") {
        finish(true)
        return
      }
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(async () => {
        try {
          const updatedTab = await chrome.tabs.get(tabId)
          finish(updatedTab.url !== originalUrl)
        } catch {
          finish(false)
        }
      }, 1200)
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
  })
}

export default function SidePanel() {
  const [status, setStatus] = useState("Idle")
  const [commentary, setCommentary] = useState("")
  const [isRunning, setIsRunning] = useState(false)

  const runNewsStep = async () => {
    if (isRunning) return
    setIsRunning(true)

    let tabId: number | undefined
    let debuggerAttached = false

    try {
      setCommentary("")
      setStatus("Connecting to active tab...")
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id == null || tab.windowId == null) throw new Error("No active tab found.")
      tabId = tab.id
      await chrome.debugger.attach({ tabId }, "1.3")
      debuggerAttached = true

      const targetArticleJumps = 10
      for (let articleIndex = 0; articleIndex <= targetArticleJumps; articleIndex += 1) {
        setStatus(`Finding headlines for article ${articleIndex + 1} of ${targetArticleJumps + 1}...`)
        const headlines: Headline[] = []
        let atBottom = false
        for (let section = 0; section < 20 && headlines.length < 10 && !atBottom; section += 1) {
          atBottom = await smoothScrollPage(tabId)
          const scan = await extractVisibleHeadlines(
            tabId,
            headlines.map((headline) => headline.href),
            headlines.length + 1,
            10 - headlines.length
          )
          headlines.push(...scan.headlines)
          atBottom ||= scan.atBottom
        }
        if (headlines.length === 0) {
          setStatus("No visible headline links found after scanning the page.")
          return
        }

        const prompt = `Choose the most promising news headline to open. Do not choose navigation, category, or promotional links. React to the headlines with a lively, opinionated one-sentence comment, without inventing facts. Select one provided id, or -1 if none is a news article. Return only JSON: {"selectedId": number, "commentary": "string"}.\n\nHeadlines JSON:\n${JSON.stringify(headlines.map(({ id, text }) => ({ id, text })))}`
        const engine = await getLocalEngine(setStatus)
        setStatus(`Selecting a headline locally with ${localModelId}...`)
        const completion = await engine.chat.completions.create({
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7,
          max_tokens: 120
        })
        const rawText = completion.choices[0]?.message.content
        if (!rawText) throw new Error("Local model returned no selection.")
        const action = JSON.parse(typeof rawText === "string" ? rawText : JSON.stringify(rawText))
        if (typeof action.commentary !== "string" || typeof action.selectedId !== "number" || !Number.isInteger(action.selectedId)) {
          throw new Error("Local model returned an invalid selection.")
        }
        setCommentary(action.commentary)

        if (articleIndex === targetArticleJumps) {
          setStatus(`Finished reacting to ${targetArticleJumps + 1} pages.`)
          return
        }

        const target = headlines.find((headline) => headline.id === action.selectedId)
        if (!target) {
          setStatus("No suitable headline selected; stopping the sequence.")
          return
        }

        const targetPosition = await scrollHeadlineIntoView(tabId, target.href)
        if (!targetPosition) {
          setStatus("The selected headline is no longer available on the page.")
          return
        }
        const cursorPosition = await ensureVirtualCursor(tabId)
        setStatus(`Moving cursor to headline ${target.id}...`)
        await animateCursorToTarget(tabId, cursorPosition, targetPosition)

        const originalUrl = (await chrome.tabs.get(tabId)).url
        const navigation = waitForNavigation(tabId, originalUrl)
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mousePressed", x: targetPosition.x, y: targetPosition.y, button: "left", clickCount: 1
        })
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x: targetPosition.x, y: targetPosition.y, button: "left", clickCount: 1
        })
        setStatus(`Opening article ${articleIndex + 2} of ${targetArticleJumps + 1}...`)
        if (!await navigation) {
          setStatus("The selected headline did not navigate; stopping the sequence.")
          return
        }
      }
    } catch (err) {
      console.error(err)
      setStatus(`Error: ${getErrorMessage(err)}`)
    } finally {
      if (debuggerAttached && tabId != null) {
        try {
          await chrome.debugger.detach({ tabId })
        } catch (err) {
          console.warn("Could not detach Chrome debugger:", err)
        }
      }
      setIsRunning(false)
    }
  }

  return (
    <div className="p-4 flex flex-col gap-4 font-sans border-t border-gray-200">
      <h1 className="text-lg font-bold text-gray-800">AI News Reactor</h1>
      <button
        onClick={runNewsStep}
        disabled={isRunning}
        className="bg-blue-600 text-white font-semibold py-2 px-4 rounded hover:bg-blue-700 transition">
        {isRunning ? "Reacting and browsing..." : "Run News Step"}
      </button>
      <div className="text-xs text-gray-500">
        <b>Status:</b> {status}
      </div>
      {commentary && (
        <div className="p-3 bg-blue-50 text-blue-900 text-sm rounded border border-blue-200">
          <b>Reaction:</b> "{commentary}"
        </div>
      )}
    </div>
  )
}