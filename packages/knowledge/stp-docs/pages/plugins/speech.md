---
id: speech
title: Speech Recognition
sidebar_position: 2
---

# Speech Recognition Plugins

STP operates by combining **speech** and **sketch** modalities. Speech collected near a sketch (within a few seconds) is considered for combined interpretation. Several strategies for handling speech are possible.

## Recognition Strategies

### 1. Sketch-to-talk

Start recognition when the sketch completes (pen-up). Best for long, detailed sketches (e.g., MSR, Axis of Advance) where speech might time out during drawing.

```javascript
let result = await speechreco.recognizeOnce();
if (result) {
    stpsdk.sendSpeechRecognition(result.results, result.startTime, result.endTime);
}
```

### 2. While sketching

Activate speech at sketch start, deactivate ~5 seconds after sketch end. This is the strategy used in most samples.

```javascript
// On pen down:
speechreco.startRecognizing();

// On pen up:
speechreco.stopRecognizing(5); // wait 5 seconds
```

### 3. Continuous recognition

Keep the microphone open continuously. STP has mechanisms to consider only relevant speech. Maximizes capture but adds computational cost.

### 4. Pre-stroke audio buffering

Capture ~2 seconds of audio before stroke start to avoid losing speech that begins slightly before sketching. Requires specific audio techniques beyond the scope of this guide.

## Available Plugins

| Plugin | Service | Package |
|--------|---------|---------|
| Azure Speech | Microsoft Cognitive Services Speech-to-Text | [`azurespeech-plugin`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/speech/azurespeech-plugin) |
| AWS Speech | Amazon Transcribe | [`awsspeech-plugin`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/speech/awsspeech-plugin) |
| Vosk Speech | Offline recognition via WebAssembly (no cloud required) | [`voskspeech-plugin`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/speech/voskspeech-plugin) |

## ISpeechRecognizer Interface

### One-shot recognition

```typescript
/**
 * Activate microphone and attempt recognition
 * @param maxRetries Number of retries before returning error
 * @returns Recognized hypotheses, or null
 */
recognizeOnce(maxRetries?: number): Promise<ISpeechRecoResult | null>;
```

### Continuous / while-sketching recognition

```typescript
/** Start recognition. Results arrive via events. */
startRecognizing(): void;

/** Stop recognition after an optional wait period (seconds). */
stopRecognizing(wait?: number): void;
```

### Events

```typescript
/** Final phrase recognized */
onRecognized: ((result: ISpeechRecoResult | null) => void) | undefined;

/** Partial/interim hypothesis (for user feedback) */
onRecognizing: ((snippet: string) => void) | undefined;

/** Recognition error */
onError: ((error: Error) => void) | undefined;
```

:::tip
Call `stopRecognizing()` when `onRecognized` fires the first phrase. Otherwise the microphone stays open and additional (likely unrelated) phrases may be captured.
:::

## Recognition Results

```typescript
export interface ISpeechRecoResult {
    /** Ranked hypotheses */
    results: ISpeechRecoItem[];
    /** Time speech started */
    startTime: Date;
    /** Time speech ended */
    endTime: Date;
}

export interface ISpeechRecoItem {
    /** Transcribed text */
    text: string;
    /** Interpretation confidence */
    confidence: number;
}
```

## Sending Results to STP

Once speech is recognized, forward it to STP for fusion with sketch data:

```javascript
stpsdk.sendSpeechRecognition(recoResult.results, recoResult.startTime, recoResult.endTime);
```

STP may select a different hypothesis than the top-ranked one, based on mutual disambiguation with the sketch modality.

---

:::info Source & Samples
Speech plugin source and documentation: [sketch-thru-plan-sdk-js/plugins/speech](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/speech)
:::
