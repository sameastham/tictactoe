package mx.espanolcoach.app

import android.util.Log
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method

/**
 * Reflective binder for a gomobile-generated Java class exposing Go's
 * exported package-level funcs as static methods.
 *
 * This is `internal`, not `private`, and takes [className] as a constructor
 * argument rather than a hardcoded constant, specifically so it's unit
 * testable end to end (android/app/src/test/java/mx/espanolcoach/app/TsBridgeTest.kt,
 * against a fake `tsbridge.Tsbridge` fixture at
 * android/app/src/test/java/tsbridge/Tsbridge.kt): each instance does its
 * own independent `Class.forName` + method-resolution pass, so a test can
 * exercise both the resolved-and-working path (the fake class present under
 * its real name) and the class-not-found fallback path (a bogus class name)
 * in the same JVM run — something [TsBridge] itself, a plain singleton
 * `object` whose `init` block only ever runs once per classloader, cannot
 * do on its own.
 */
internal class TsBridgeBinder(private val logTag: String, className: String) {
    private var mPrepare: Method? = null
    private var mStartForward: Method? = null
    private var mStop: Method? = null
    private var mStatus: Method? = null

    /** True once the target class and all four expected methods resolved. */
    val isAvailable: Boolean
        get() = mPrepare != null && mStartForward != null && mStop != null && mStatus != null

    init {
        try {
            val c = Class.forName(className)
            mPrepare = findMethod(c, "prepare", String::class.java, String::class.java)
            mStartForward = findMethod(
                c,
                "startForward",
                String::class.java,
                String::class.java,
                String::class.java,
                String::class.java,
                String::class.java,
            )
            mStop = findMethod(c, "stop")
            mStatus = findMethod(c, "status")
            if (isAvailable) {
                Log.i(logTag, "$className bound successfully — tunnel mode available")
            } else {
                Log.w(logTag, "$className found but one or more expected methods are missing; tunnel mode unavailable")
            }
        } catch (e: ClassNotFoundException) {
            Log.i(logTag, "$className not on classpath (no tsbridge.aar bundled) — tunnel mode unavailable")
        } catch (e: Throwable) {
            Log.w(logTag, "failed to bind to $className reflectively — tunnel mode unavailable", e)
        }
    }

    /**
     * Exact-name lookup first, falling back to a case-insensitive scan by
     * name + arity — tolerates gomobile renaming/recasing its generated
     * methods across versions without this wrapper going stale silently.
     */
    private fun findMethod(c: Class<*>, name: String, vararg paramTypes: Class<*>): Method? {
        return try {
            c.getMethod(name, *paramTypes)
        } catch (e: NoSuchMethodException) {
            c.methods.firstOrNull { m ->
                m.name.equals(name, ignoreCase = true) && m.parameterTypes.size == paramTypes.size
            }
        }
    }

    /** Unwraps InvocationTargetException so callers see the real cause. */
    private fun invokeStatic(m: Method, vararg args: Any?): Any? {
        return try {
            m.invoke(null, *args)
        } catch (e: InvocationTargetException) {
            throw RuntimeException(e.targetException?.message ?: e.message, e.targetException ?: e)
        }
    }

    /** tsbridge.Prepare(cacheDir, homeDir). */
    fun prepare(cacheDir: String, homeDir: String) {
        val m = mPrepare ?: error("tsbridge unavailable: prepare")
        invokeStatic(m, cacheDir, homeDir)
    }

    /**
     * tsbridge.StartForward(stateDir, hostname, authKey, controlURL,
     * hubHostPort) -> loopback port. Throws if the underlying Go call
     * returns an error. The generated Java method returns `long` (gomobile
     * maps Go's platform-`int` to Java `long`, not `int`); this narrows it
     * back to Int for callers, since a real TCP port always fits.
     */
    fun startForward(
        stateDir: String,
        hostname: String,
        authKey: String,
        controlURL: String,
        hubHostPort: String,
    ): Int {
        val m = mStartForward ?: error("tsbridge unavailable: startForward")
        val ret = invokeStatic(m, stateDir, hostname, authKey, controlURL, hubHostPort)
        return when (ret) {
            is Int -> ret
            is Long -> ret.toInt()
            is Number -> ret.toInt()
            else -> error("tsbridge.startForward returned unexpected type: $ret")
        }
    }

    /** tsbridge.Stop(). A no-op (not an error) if the class never resolved. */
    fun stop() {
        val m = mStop ?: return
        invokeStatic(m)
    }

    /** tsbridge.Status() -> JSON string, or null if unavailable. */
    fun status(): String? {
        val m = mStatus ?: return null
        return invokeStatic(m) as? String
    }
}

/**
 * Reflective wrapper around the gomobile-generated `tsbridge.Tsbridge` Java
 * class (from android/app/libs/tsbridge.aar, built by
 * scripts/build-tsbridge.sh from the tsbridge/ Go module — see that
 * script's header comment).
 *
 * This is reflective, not a compile-time dependency (android/app/build.gradle
 * only globs `*.aar` files under `libs` via `fileTree`), so the app BUILDS AND RUNS
 * whether or not tsbridge.aar is present: if the class can't be found on the
 * classpath, [isAvailable] is false and the app falls back to the static
 * capacitor `server.url` behavior untouched (see MainActivity, TunnelManager).
 *
 * Class/method naming, verified against the actual built .aar (`unzip -l`
 * the .aar's classes.jar / `javap`, per the build report — see
 * scripts/build-tsbridge.sh's output): gomobile's Java binding names the
 * generated class after the Go package (`JavaClassName` = `Title(pkgName)`,
 * with an empty `-javapkg` prefix, i.e. no "go." prefix) — Go package
 * `tsbridge` becomes Java class `tsbridge.Tsbridge` — and Go's exported
 * package-level funcs become static methods with the same name, first
 * letter lowercased (`StartForward` -> `startForward`). A Go `(T, error)`
 * return becomes a Java method returning `T` that throws on the error case;
 * a plain Go `int` return maps to Java `long`, not `int` (see
 * [TsBridgeBinder.startForward]). Method lookup still falls back to a
 * case-insensitive scan (`TsBridgeBinder.findMethod`) in case gomobile's
 * naming convention shifts in a future x/mobile release.
 */
object TsBridge {
    private const val CLASS_NAME = "tsbridge.Tsbridge"
    private val binder = TsBridgeBinder("TsBridge", CLASS_NAME)

    val isAvailable: Boolean get() = binder.isAvailable

    fun prepare(cacheDir: String, homeDir: String) = binder.prepare(cacheDir, homeDir)

    fun startForward(
        stateDir: String,
        hostname: String,
        authKey: String,
        controlURL: String,
        hubHostPort: String,
    ): Int = binder.startForward(stateDir, hostname, authKey, controlURL, hubHostPort)

    fun stop() = binder.stop()

    fun status(): String? = binder.status()
}
