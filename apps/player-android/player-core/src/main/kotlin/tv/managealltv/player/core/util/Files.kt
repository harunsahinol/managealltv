package tv.managealltv.player.core.util

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest

/**
 * File helpers restricted to java.io so they run on API 24 without desugaring of java.nio.file
 * (Files.move/ATOMIC_MOVE needs API 26).
 */
object AtomicFiles {
    /** Writes [bytes] to a sibling temp file, fsyncs it and renames it over [target]. */
    fun write(target: File, bytes: ByteArray) {
        val parent = target.absoluteFile.parentFile ?: throw IOException("No parent directory for $target")
        if (!parent.isDirectory && !parent.mkdirs()) throw IOException("Cannot create $parent")
        val temp = File(parent, target.name + ".tmp")
        FileOutputStream(temp).use { out ->
            out.write(bytes)
            out.flush()
            out.fd.sync()
        }
        replace(temp, target)
    }

    fun writeText(target: File, text: String) = write(target, text.toByteArray(Charsets.UTF_8))

    /**
     * Renames [source] to [target]. On POSIX file systems (Android, Linux) rename(2) replaces the
     * target atomically, so readers see either the old or the new file, never a partial one.
     */
    fun replace(source: File, target: File) {
        if (source.renameTo(target)) return
        // Only reached on file systems whose rename refuses to overwrite (not the case on Android).
        if (target.exists() && !target.delete()) throw IOException("Cannot replace $target")
        if (!source.renameTo(target)) throw IOException("Cannot rename $source to $target")
    }
}

object Hashing {
    private val HEX = "0123456789abcdef".toCharArray()

    /** Lowercase hex; java.util.HexFormat would need API 34 on Android. */
    fun toHex(bytes: ByteArray): String {
        val chars = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xff
            chars[i * 2] = HEX[v ushr 4]
            chars[i * 2 + 1] = HEX[v and 0x0f]
        }
        return String(chars)
    }

    fun sha256() = MessageDigest.getInstance("SHA-256")

    fun sha256Hex(bytes: ByteArray): String = toHex(sha256().digest(bytes))

    /** Feeds the whole file into [digest] (used to resume hashing of a partial download). */
    fun update(digest: MessageDigest, file: File) {
        FileInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
    }

    fun sha256Hex(file: File): String {
        val digest = sha256()
        update(digest, file)
        return toHex(digest.digest())
    }

    private val SHA256_HEX = Regex("^[a-f0-9]{64}$")

    /** Same rule as `Sha256Hex` in common.ts. Also guards file names built from server data. */
    fun isSha256Hex(value: String): Boolean = SHA256_HEX.matches(value)
}
