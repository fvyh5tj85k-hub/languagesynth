# Zuroka Melys — two voices

Инструмент рассказывает о двух людях, которые говорят на разных языках и не понимают друг друга. Левая и правая половины — два независимых синтезатора, которые можно играть отдельно или одновременно.

## Synth A — English

- Клавиши: `A S D F`
- Ноты: `C4 D4 E4 G4`
- Waveform: `sine` или `triangle`
- Панорама: немного влево (`-0.5`)

## Synth B — Japanese

- Клавиши: `J K L ;`
- Ноты: `A4 C5 D5 E5`
- Waveform: `square` или `sawtooth`
- Панорама: немного вправо (`+0.5`)

## Эффекты

В каждом голосе работают distortion, delay, reverb, chorus/modulation и low-pass filter. Общий compressor защищает выход от резких скачков громкости.

## CLEAN / DIRTY slider

Центральный ползунок — точка восприятия между двумя языками. Слева English звучит чисто, а Japanese грязно. В центре оба обработаны одинаково. Справа English становится грязнее, а Japanese — чище. Обработка меняется плавно и слышна даже во время удержания ноты.

## Audio chain

```text
ENGLISH / SYNTH A
keys A S D F
→ oscillator (sine / triangle)
→ envelope
→ distortion + delay + reverb + chorus + filter
→ pan left
→ master compressor

JAPANESE / SYNTH B
keys J K L ;
→ oscillator (square / sawtooth)
→ envelope
→ distortion + delay + reverb + chorus + filter
→ pan right
→ master compressor

PERSPECTIVE
→ English dirty amount
→ Japanese dirty amount (inverse)
```

## Сценарий предпросмотра на 20–30 секунд

1. Оставить slider в центре. Сыграть `A S D F`, затем простой аккорд `A + D`.
2. Переключить English с `sine` на `triangle` и повторить две ноты.
3. Сыграть `J K L ;`, затем переключить Japanese с `square` на `saw`.
4. Удерживать `A + D` и добавить `J + L`, чтобы оба голоса звучали одновременно.
5. Во время удержания нот медленно передвинуть slider вправо: English станет грязнее, Japanese чище.
6. Медленно передвинуть slider влево: English очистится, Japanese станет грязнее.
7. Вернуть slider в центр и закончить короткой последовательностью `A J S K D L F ;`.
