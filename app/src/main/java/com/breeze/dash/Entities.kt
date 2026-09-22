package com.breeze.dash

/**
 * A falling wall with a single gap the player has to steer through.
 * Stored as the gap bounds so collision is a simple "am I inside the gap?" test.
 */
class Barrier(
    var y: Float,
    var gapStart: Float,
    var gapEnd: Float,
    var height: Float
) {
    /** Scored once, when the barrier has fully passed the player. */
    var scored = false

    /** Cleared by a shield hit so the wall stops being lethal. */
    var broken = false
}

/** Collectible floating down with the barriers. */
class Pickup(
    var x: Float,
    var y: Float,
    var radius: Float,
    val kind: Kind
) {
    var collected = false
    var spin = 0f

    enum class Kind { GEM, SHIELD }
}

/** Short-lived bit of visual feedback: dust, sparkles, debris. */
class Particle(
    var x: Float,
    var y: Float,
    var vx: Float,
    var vy: Float,
    var radius: Float,
    var life: Float,
    var maxLife: Float,
    var color: Int
)

/** Background wind line, purely decorative parallax. */
class Streak(
    var x: Float,
    var y: Float,
    var length: Float,
    var speedFactor: Float,
    var alpha: Int
)
