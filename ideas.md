# Future Ideas & Feature Roadmap

This document outlines the conceptual roadmap, features to build, and strategies to achieve full saturation for the YouTube Auto-Transcript Drawer.

## Feature Saturation Roadmap

### 📱 1. Mobile Experience (Web & Extension)
* **Responsive Sidebar Panel:** Allow the panel to collapse into a bottom sheet drawer on mobile viewports so that users can read transcripts comfortably on mobile browsers (Safari iOS, Orion, Chrome iOS).
* **Touch-Optimized Seek Target:** Expand the tap targets of timestamps on touch screens to prevent accidental misses.

### 🎓 2. Academic & Research Features
* **Citation Generator:** Add an APA/MLA/Chicago citation generator based on the video title, author, URL, and date, allowing researchers to cite YouTube videos instantly.
* **Segment Annotation:** Allow users to highlight specific transcript segments, add brief text notes, and export these annotations as markdown files.
* **PDF Export:** Support downloading the transcript formatted as a clean, paginated PDF report with video metadata.

### 🔍 3. Advanced Discovery & Syncing
* **Keyword Alerting:** Let users define a list of keywords; highlight matches in the transcript and show indicator ticks on the custom scrollbar.
* **Embed Anchor Seeks:** Add an option to click a timestamp and seek an embedded YouTube player if the extension is running on external websites.
* **Search History (⌘K / ⌘F):** Keep a list of recent transcript searches to help users jump back to previous queries.

### 🌐 4. Social & Sharing
* **Share Timestamp Link:** Add a direct "Share Link" button on each segment row that copies the YouTube watch URL with the exact timestamp parameter (e.g. `&t=83s`).
* **Short-Form Clip Exporter:** Allow users to select a range of lines, copy the raw text, and estimate the duration of the clip (useful for creating YouTube Shorts/TikToks).

### 🤖 5. Custom AI Integration
* **Custom Prompts:** Allow users to write their own system prompt templates for AI summaries (e.g., "Translate to Spanish", "Extract recipes", "Create code snippets").
* **Local WebLLM / Ollama Support:** Add option to run summarization locally using Chrome's built-in Gemini Nano API or an Ollama local endpoint.
