package com.breeze.dash

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/**
 * Breeze Dash: steer a leaf through the gaps in falling walls, grab gems,
 * survive as long as you can. Everything is drawn on a software canvas from a
 * dedicated render thread, so there are no dependencies beyond the framework.
 */
class GameView(context: Context) : SurfaceView(context), SurfaceHolder.Callback, Runnable {

    private enum class State { READY, RUNNING, PAUSED, GAME_OVER }

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Volatile
    private var running = false
    private var thread: Thread? = null

    @Volatile
    private var state = State.READY

    private var w = 0f
    private var h = 0f

    // --- player ---------------------------------------------------------
    private var playerX = 0f
    private var targetX = 0f
    private var playerY = 0f
    private var playerW = 0f
    private var playerH = 0f
    private var tilt = 0f

    // --- world ----------------------------------------------------------
    private val barriers = ArrayList<Barrier>()
    private val pickups = ArrayList<Pickup>()
    private val particles = ArrayList<Particle>()
    private val streaks = ArrayList<Streak>()

    private var spawnTimer = 0f
    private var lastGapCenter = 0.5f
    private var elapsed = 0f
    private var score = 0
    private var best = prefs.getInt(KEY_BEST, 0)
    private var shields = 0
    private var shake = 0f
    private var stateTime = 0f
    private var trailTimer = 0f

    // Input arrives on the UI thread but is applied on the game thread, so the
    // world is only ever mutated from one place.
    @Volatile
    private var pendingTouchX = Float.NaN

    @Volatile
    private var pendingTap = false

    @Volatile
    private var pendingPause = false

    // --- paint ----------------------------------------------------------
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }
    private val bg = Paint()
    private val hudText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = android.graphics.Typeface.DEFAULT_BOLD
    }
    private val centerText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = android.graphics.Typeface.DEFAULT_BOLD
        textAlign = Paint.Align.CENTER
    }

    private val leaf = Path()
    private val rect = RectF()
    private val random = Random(System.nanoTime())

    init {
        holder.addCallback(this)
        isFocusable = true
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    override fun surfaceCreated(holder: SurfaceHolder) = Unit

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        w = width.toFloat()
        h = height.toFloat()

        playerW = w * 0.135f
        playerH = playerW * 0.66f
        playerY = h * 0.79f
        if (state != State.RUNNING) {
            playerX = w * 0.5f
            targetX = playerX
        }

        bg.shader = LinearGradient(
            0f, 0f, 0f, h,
            intArrayOf(
                Color.rgb(12, 26, 48),
                Color.rgb(20, 52, 76),
                Color.rgb(16, 78, 84)
            ),
            floatArrayOf(0f, 0.55f, 1f),
            Shader.TileMode.CLAMP
        )

        hudText.textSize = w * 0.055f
        stroke.strokeWidth = w * 0.012f

        if (streaks.isEmpty()) seedStreaks()
        if (state == State.READY) resetWorld()
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) = Unit

    fun resume() {
        if (running) return
        running = true
        thread = Thread(this, "breeze-dash-loop").also { it.start() }
    }

    fun pauseLoop() {
        running = false
        thread?.let { t ->
            while (t.isAlive) {
                try {
                    t.join()
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return
                }
            }
        }
        thread = null
        if (state == State.RUNNING) setState(State.PAUSED)
    }

    /** @return true when the view consumed the back gesture. */
    fun onBackPressed(): Boolean {
        if (state == State.RUNNING) {
            pendingPause = true
            return true
        }
        return false
    }

    private fun setState(next: State) {
        state = next
        stateTime = 0f
    }

    // ------------------------------------------------------------------
    // Loop
    // ------------------------------------------------------------------

    override fun run() {
        var last = System.nanoTime()
        while (running) {
            val frameStart = System.nanoTime()
            var dt = (frameStart - last) / 1_000_000_000f
            last = frameStart
            if (dt > MAX_STEP) dt = MAX_STEP

            update(dt)
            render()

            // Pace the loop so we do not spin the CPU when the surface is not
            // ready yet or when the compositor hands frames back immediately.
            val spent = System.nanoTime() - frameStart
            val remaining = (FRAME_NANOS - spent) / 1_000_000L
            if (remaining > 0L) {
                try {
                    Thread.sleep(remaining)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return
                }
            }
        }
    }

    private fun render() {
        val surface = holder
        if (!surface.surface.isValid) return
        val canvas: Canvas = try {
            surface.lockCanvas() ?: return
        } catch (_: IllegalArgumentException) {
            return
        }
        try {
            drawFrame(canvas)
        } finally {
            try {
                surface.unlockCanvasAndPost(canvas)
            } catch (_: IllegalStateException) {
                // Surface went away mid-frame; the next frame will bail out early.
            }
        }
    }

    // ------------------------------------------------------------------
    // Simulation
    // ------------------------------------------------------------------

    private fun resetWorld() {
        barriers.clear()
        pickups.clear()
        particles.clear()
        spawnTimer = 0f
        elapsed = 0f
        score = 0
        shields = 0
        shake = 0f
        tilt = 0f
        lastGapCenter = 0.5f
        playerX = w * 0.5f
        targetX = playerX
        pendingTouchX = Float.NaN
    }

    private fun seedStreaks() {
        streaks.clear()
        repeat(26) {
            streaks.add(
                Streak(
                    x = random.nextFloat(),
                    y = random.nextFloat(),
                    length = 0.04f + random.nextFloat() * 0.10f,
                    speedFactor = 0.35f + random.nextFloat() * 0.9f,
                    alpha = 22 + random.nextInt(40)
                )
            )
        }
    }

    /** Fall speed in px/s, ramping up with time survived. */
    private fun fallSpeed(): Float = h * (0.40f + min(elapsed * 0.012f, 0.45f))

    private fun gapWidth(): Float = w * max(0.24f, 0.36f - elapsed * 0.004f)

    private fun spawnInterval(): Float = max(0.52f, 1.05f - elapsed * 0.014f)

    private fun update(dt: Float) {
        if (w <= 0f || h <= 0f) return

        consumeInput()
        updateStreaks(dt)
        updateParticles(dt)

        if (state != State.RUNNING) {
            stateTime += dt
            if (shake > 0f) shake = max(0f, shake - dt * 2.4f)
            return
        }
        stateTime += dt

        elapsed += dt
        val speed = fallSpeed()

        // Player follows the finger with a little inertia, and tilts into the turn.
        val prevX = playerX
        playerX += (targetX - playerX) * min(1f, dt * 16f)
        playerX = playerX.coerceIn(playerW * 0.5f, w - playerW * 0.5f)
        val drift = (playerX - prevX) / max(dt, 0.0001f)
        tilt += ((drift / (w * 2.2f)).coerceIn(-0.5f, 0.5f) - tilt) * min(1f, dt * 8f)

        trailTimer -= dt
        if (trailTimer <= 0f) {
            trailTimer = 0.035f
            spawnTrail()
        }

        spawnTimer -= dt
        if (spawnTimer <= 0f) {
            spawnTimer = spawnInterval()
            spawnBarrier()
        }

        moveBarriers(dt, speed)
        movePickups(dt, speed)

        if (shake > 0f) shake = max(0f, shake - dt * 2.4f)
    }

    private fun consumeInput() {
        if (pendingPause) {
            pendingPause = false
            if (state == State.RUNNING) setState(State.PAUSED)
        }

        if (pendingTap) {
            pendingTap = false
            when (state) {
                State.READY -> {
                    resetWorld()
                    setState(State.RUNNING)
                }
                State.PAUSED -> setState(State.RUNNING)
                State.GAME_OVER -> if (stateTime > RESTART_DELAY) {
                    resetWorld()
                    setState(State.RUNNING)
                }
                State.RUNNING -> Unit
            }
        }

        val x = pendingTouchX
        if (!x.isNaN()) targetX = x
    }

    private fun updateStreaks(dt: Float) {
        val speed = if (state == State.RUNNING) fallSpeed() else h * 0.18f
        for (s in streaks) {
            s.y += (speed * s.speedFactor * dt) / h
            if (s.y > 1.1f) {
                s.y = -s.length
                s.x = random.nextFloat()
            }
        }
    }

    private fun updateParticles(dt: Float) {
        var i = particles.size - 1
        while (i >= 0) {
            val p = particles[i]
            p.life -= dt
            if (p.life <= 0f) {
                particles.removeAt(i)
            } else {
                p.x += p.vx * dt
                p.y += p.vy * dt
                p.vy += h * 0.35f * dt
            }
            i--
        }
    }

    private fun spawnBarrier() {
        val gap = gapWidth()
        // Keep consecutive gaps reachable so every wall is fair.
        val maxShift = 0.42f
        val lo = max(0f, lastGapCenter - maxShift)
        val hi = min(1f, lastGapCenter + maxShift)
        val half = (gap * 0.5f) / w
        var center = lo + random.nextFloat() * (hi - lo)
        center = center.coerceIn(half + 0.02f, 1f - half - 0.02f)
        lastGapCenter = center

        val gapStart = center * w - gap * 0.5f
        val barrier = Barrier(
            y = -h * 0.05f,
            gapStart = gapStart,
            gapEnd = gapStart + gap,
            height = h * 0.028f
        )
        barriers.add(barrier)

        val roll = random.nextFloat()
        if (roll < 0.10f && shields < MAX_SHIELDS) {
            pickups.add(
                Pickup(center * w, barrier.y - h * 0.16f, w * 0.042f, Pickup.Kind.SHIELD)
            )
        } else if (roll < 0.78f) {
            pickups.add(
                Pickup(center * w, barrier.y - h * 0.16f, w * 0.032f, Pickup.Kind.GEM)
            )
        }
    }

    private fun moveBarriers(dt: Float, speed: Float) {
        val left = playerX - playerW * 0.34f
        val right = playerX + playerW * 0.34f
        val top = playerY - playerH * 0.28f
        val bottom = playerY + playerH * 0.28f

        var i = barriers.size - 1
        while (i >= 0) {
            val b = barriers[i]
            b.y += speed * dt

            if (!b.broken && b.y + b.height >= top && b.y <= bottom) {
                val insideGap = left >= b.gapStart && right <= b.gapEnd
                if (!insideGap) onHit(b)
            }

            if (!b.scored && b.y > bottom) {
                b.scored = true
                score += 10
            }

            if (b.y > h + b.height) barriers.removeAt(i)
            i--
        }
    }

    private fun movePickups(dt: Float, speed: Float) {
        val reach = playerW * 0.42f
        var i = pickups.size - 1
        while (i >= 0) {
            val p = pickups[i]
            p.y += speed * dt
            p.spin += dt * 3.2f

            val dx = p.x - playerX
            val dy = p.y - playerY
            if (!p.collected && dx * dx + dy * dy <= (reach + p.radius) * (reach + p.radius)) {
                p.collected = true
                onPickup(p)
                pickups.removeAt(i)
            } else if (p.y > h + p.radius) {
                pickups.removeAt(i)
            }
            i--
        }
    }

    private fun onPickup(p: Pickup) {
        if (p.kind == Pickup.Kind.SHIELD) {
            shields = min(MAX_SHIELDS, shields + 1)
            burst(p.x, p.y, 18, COLOR_SHIELD)
        } else {
            score += 25
            burst(p.x, p.y, 12, COLOR_GEM)
        }
    }

    private fun onHit(b: Barrier) {
        shake = 1f
        if (shields > 0) {
            shields--
            b.broken = true
            b.scored = true
            burst(playerX, playerY, 26, COLOR_SHIELD)
            return
        }
        burst(playerX, playerY, 34, COLOR_LEAF)
        setState(State.GAME_OVER)
        if (score > best) {
            best = score
            prefs.edit().putInt(KEY_BEST, best).apply()
        }
    }

    private fun spawnTrail() {
        if (particles.size > MAX_PARTICLES) return
        particles.add(
            Particle(
                x = playerX + (random.nextFloat() - 0.5f) * playerW * 0.4f,
                y = playerY + playerH * 0.3f,
                vx = (random.nextFloat() - 0.5f) * w * 0.06f,
                vy = -h * 0.02f,
                radius = w * (0.006f + random.nextFloat() * 0.008f),
                life = 0.45f,
                maxLife = 0.45f,
                color = COLOR_TRAIL
            )
        )
    }

    private fun burst(x: Float, y: Float, count: Int, color: Int) {
        repeat(count) {
            if (particles.size > MAX_PARTICLES) return
            val angle = random.nextFloat() * (Math.PI * 2).toFloat()
            val speed = w * (0.15f + random.nextFloat() * 0.5f)
            val life = 0.35f + random.nextFloat() * 0.45f
            particles.add(
                Particle(
                    x = x,
                    y = y,
                    vx = cos(angle) * speed,
                    vy = sin(angle) * speed,
                    radius = w * (0.006f + random.nextFloat() * 0.012f),
                    life = life,
                    maxLife = life,
                    color = color
                )
            )
        }
    }

    // ------------------------------------------------------------------
    // Input
    // ------------------------------------------------------------------

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pendingTouchX = event.x
                pendingTap = true
                performClick()
            }
            MotionEvent.ACTION_MOVE -> pendingTouchX = event.x
        }
        return true
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    private fun drawFrame(canvas: Canvas) {
        if (w <= 0f || h <= 0f) {
            canvas.drawColor(Color.BLACK)
            return
        }

        canvas.drawRect(0f, 0f, w, h, bg)

        val shakeX = if (shake > 0f) (random.nextFloat() - 0.5f) * w * 0.03f * shake else 0f
        val shakeY = if (shake > 0f) (random.nextFloat() - 0.5f) * w * 0.03f * shake else 0f
        canvas.save()
        canvas.translate(shakeX, shakeY)

        drawStreaks(canvas)
        drawBarriers(canvas)
        drawPickups(canvas)
        drawParticles(canvas)
        drawPlayer(canvas)

        canvas.restore()

        drawHud(canvas)
        drawOverlay(canvas)
    }

    private fun drawStreaks(canvas: Canvas) {
        stroke.strokeWidth = w * 0.006f
        for (s in streaks) {
            stroke.color = Color.argb(s.alpha, 200, 240, 255)
            val x = s.x * w
            canvas.drawLine(x, s.y * h, x, (s.y + s.length) * h, stroke)
        }
    }

    private fun drawBarriers(canvas: Canvas) {
        val radius = h * 0.012f
        for (b in barriers) {
            if (b.broken) continue
            fill.color = COLOR_WALL
            if (b.gapStart > 0f) {
                rect.set(-radius, b.y, b.gapStart, b.y + b.height)
                canvas.drawRoundRect(rect, radius, radius, fill)
            }
            if (b.gapEnd < w) {
                rect.set(b.gapEnd, b.y, w + radius, b.y + b.height)
                canvas.drawRoundRect(rect, radius, radius, fill)
            }

            // Highlight the mouth of the gap so it reads instantly.
            stroke.color = COLOR_GAP_EDGE
            stroke.strokeWidth = h * 0.004f
            canvas.drawLine(b.gapStart, b.y, b.gapStart, b.y + b.height, stroke)
            canvas.drawLine(b.gapEnd, b.y, b.gapEnd, b.y + b.height, stroke)
        }
    }

    private fun drawPickups(canvas: Canvas) {
        for (p in pickups) {
            val pulse = 1f + 0.12f * sin(p.spin * 2f)
            if (p.kind == Pickup.Kind.GEM) {
                fill.color = Color.argb(60, 255, 214, 102)
                canvas.drawCircle(p.x, p.y, p.radius * 2.1f * pulse, fill)
                fill.color = COLOR_GEM
                canvas.drawCircle(p.x, p.y, p.radius * pulse, fill)
            } else {
                fill.color = Color.argb(60, 110, 220, 255)
                canvas.drawCircle(p.x, p.y, p.radius * 1.9f * pulse, fill)
                stroke.color = COLOR_SHIELD
                stroke.strokeWidth = p.radius * 0.36f
                canvas.drawCircle(p.x, p.y, p.radius * pulse, stroke)
                canvas.drawLine(p.x - p.radius * 0.45f, p.y, p.x + p.radius * 0.45f, p.y, stroke)
                canvas.drawLine(p.x, p.y - p.radius * 0.45f, p.x, p.y + p.radius * 0.45f, stroke)
            }
        }
    }

    private fun drawParticles(canvas: Canvas) {
        for (p in particles) {
            val t = (p.life / p.maxLife).coerceIn(0f, 1f)
            fill.color = Color.argb(
                (Color.alpha(p.color) * t).toInt().coerceIn(0, 255),
                Color.red(p.color),
                Color.green(p.color),
                Color.blue(p.color)
            )
            canvas.drawCircle(p.x, p.y, p.radius * (0.4f + t * 0.6f), fill)
        }
    }

    private fun drawPlayer(canvas: Canvas) {
        if (state == State.GAME_OVER) return

        canvas.save()
        canvas.translate(playerX, playerY)
        canvas.rotate(tilt * 24f)

        val hw = playerW * 0.5f
        val hh = playerH * 0.5f

        leaf.reset()
        leaf.moveTo(0f, -hh * 1.25f)
        leaf.cubicTo(hw, -hh * 0.6f, hw * 0.9f, hh * 0.9f, 0f, hh * 1.25f)
        leaf.cubicTo(-hw * 0.9f, hh * 0.9f, -hw, -hh * 0.6f, 0f, -hh * 1.25f)
        leaf.close()

        fill.color = COLOR_LEAF
        canvas.drawPath(leaf, fill)

        stroke.color = COLOR_LEAF_VEIN
        stroke.strokeWidth = playerW * 0.045f
        canvas.drawLine(0f, -hh * 1.05f, 0f, hh * 1.05f, stroke)

        if (shields > 0) {
            stroke.color = Color.argb(150, 110, 220, 255)
            stroke.strokeWidth = playerW * 0.05f
            canvas.drawCircle(0f, 0f, max(hw, hh) * 1.55f, stroke)
        }

        canvas.restore()
    }

    private fun drawHud(canvas: Canvas) {
        hudText.textAlign = Paint.Align.LEFT
        hudText.color = Color.WHITE
        val pad = w * 0.06f
        val baseline = h * 0.085f
        canvas.drawText(score.toString(), pad, baseline, hudText)

        hudText.textAlign = Paint.Align.RIGHT
        hudText.color = Color.argb(170, 255, 255, 255)
        hudText.textSize = w * 0.04f
        canvas.drawText("BEST $best", w - pad, baseline, hudText)
        hudText.textSize = w * 0.055f

        fill.color = COLOR_SHIELD
        val r = w * 0.016f
        for (i in 0 until shields) {
            canvas.drawCircle(pad + r + i * (r * 3f), baseline + h * 0.035f, r, fill)
        }
    }

    private fun drawOverlay(canvas: Canvas) {
        if (state == State.RUNNING) return

        fill.color = Color.argb(150, 4, 10, 20)
        canvas.drawRect(0f, 0f, w, h, fill)

        centerText.color = Color.WHITE
        val cx = w * 0.5f

        when (state) {
            State.READY -> {
                centerText.textSize = w * 0.12f
                canvas.drawText("BREEZE", cx, h * 0.34f, centerText)
                canvas.drawText("DASH", cx, h * 0.34f + w * 0.13f, centerText)
                centerText.textSize = w * 0.045f
                centerText.color = Color.argb(210, 220, 240, 255)
                canvas.drawText("Drag to steer the leaf", cx, h * 0.52f, centerText)
                canvas.drawText("through the gaps", cx, h * 0.52f + w * 0.06f, centerText)
                canvas.drawText("Tap to start", cx, h * 0.64f, centerText)
            }
            State.PAUSED -> {
                centerText.textSize = w * 0.10f
                canvas.drawText("PAUSED", cx, h * 0.45f, centerText)
                centerText.textSize = w * 0.045f
                centerText.color = Color.argb(210, 220, 240, 255)
                canvas.drawText("Tap to resume", cx, h * 0.54f, centerText)
            }
            State.GAME_OVER -> {
                centerText.textSize = w * 0.09f
                canvas.drawText("GAME OVER", cx, h * 0.36f, centerText)
                centerText.textSize = w * 0.14f
                centerText.color = Color.rgb(255, 214, 102)
                canvas.drawText(score.toString(), cx, h * 0.50f, centerText)
                centerText.textSize = w * 0.045f
                centerText.color = Color.argb(210, 220, 240, 255)
                canvas.drawText("BEST $best", cx, h * 0.57f, centerText)
                if (stateTime > RESTART_DELAY) {
                    canvas.drawText("Tap to play again", cx, h * 0.68f, centerText)
                }
            }
            State.RUNNING -> Unit
        }
    }

    private companion object {
        const val PREFS = "breeze_dash"
        const val KEY_BEST = "best_score"
        const val MAX_STEP = 0.05f
        const val FRAME_NANOS = 1_000_000_000L / 60L
        const val MAX_PARTICLES = 200
        const val MAX_SHIELDS = 3
        const val RESTART_DELAY = 0.6f

        val COLOR_LEAF = Color.rgb(123, 228, 149)
        val COLOR_LEAF_VEIN = Color.rgb(22, 98, 74)
        val COLOR_WALL = Color.rgb(233, 84, 106)
        val COLOR_GAP_EDGE = Color.argb(200, 255, 232, 240)
        val COLOR_GEM = Color.rgb(255, 214, 102)
        val COLOR_SHIELD = Color.rgb(110, 220, 255)
        val COLOR_TRAIL = Color.argb(140, 190, 255, 215)
    }
}
