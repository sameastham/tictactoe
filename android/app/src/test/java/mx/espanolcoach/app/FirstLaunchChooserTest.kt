package mx.espanolcoach.app

import mx.espanolcoach.app.FirstLaunchChooser.Action
import org.junit.Assert.assertEquals
import org.junit.Test

/** Exercises every input combination of [FirstLaunchChooser.decide] directly — pure logic, no Android needed. */
class FirstLaunchChooserTest {
    @Test
    fun enabledAndConfiguredAlwaysAutoConnectsRegardlessOfChoice() {
        assertEquals(
            Action.AUTO_CONNECT_TUNNEL,
            FirstLaunchChooser.decide(tunnelEnabled = true, tunnelConfigured = true, choiceMade = false),
        )
        assertEquals(
            Action.AUTO_CONNECT_TUNNEL,
            FirstLaunchChooser.decide(tunnelEnabled = true, tunnelConfigured = true, choiceMade = true),
        )
    }

    @Test
    fun freshInstallWithNothingChosenShowsTheChooser() {
        assertEquals(
            Action.SHOW_CHOOSER,
            FirstLaunchChooser.decide(tunnelEnabled = false, tunnelConfigured = false, choiceMade = false),
        )
    }

    @Test
    fun freshStateButChoiceAlreadyMadeProceedsStaticInsteadOfAskingAgain() {
        assertEquals(
            Action.PROCEED_STATIC,
            FirstLaunchChooser.decide(tunnelEnabled = false, tunnelConfigured = false, choiceMade = true),
        )
    }

    @Test
    fun enabledButNotYetConfiguredNeverShowsTheChooser() {
        // Not a "fresh install" — some tunnel config exists (the switch was
        // flipped on) even though it isn't complete enough to auto-connect.
        assertEquals(
            Action.PROCEED_STATIC,
            FirstLaunchChooser.decide(tunnelEnabled = true, tunnelConfigured = false, choiceMade = false),
        )
    }

    @Test
    fun configuredButDisabledNeverShowsTheChooser() {
        // e.g. the user configured the tunnel once, then flipped it back off.
        assertEquals(
            Action.PROCEED_STATIC,
            FirstLaunchChooser.decide(tunnelEnabled = false, tunnelConfigured = true, choiceMade = false),
        )
    }
}
