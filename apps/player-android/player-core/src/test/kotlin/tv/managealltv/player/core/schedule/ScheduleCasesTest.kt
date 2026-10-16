package tv.managealltv.player.core.schedule

import java.time.Instant
import java.time.ZoneId
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import org.junit.jupiter.api.DynamicContainer
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import tv.managealltv.player.core.Fixtures
import tv.managealltv.player.core.protocol.ProtocolJson
import tv.managealltv.player.core.protocol.ScheduleRule

/** Runs every vector of packages/protocol/fixtures/schedule-cases.json, shared with the TypeScript side. */
class ScheduleCasesTest {
    @Serializable
    private data class CasesFile(val description: String, val groups: List<Group>)

    @Serializable
    private data class Group(
        val name: String,
        val timezone: String,
        val defaultPlaylistId: String?,
        val rules: List<ScheduleRule>,
        val cases: List<Case>,
    )

    @Serializable
    private data class Case(val name: String, val nowUtc: String, val expectedPlaylistId: String?)

    private val file: CasesFile by lazy {
        ProtocolJson.strict.decodeFromString(CasesFile.serializer(), Fixtures.read("schedule-cases.json"))
    }

    @TestFactory
    fun `schedule vectors`(): List<DynamicContainer> =
        file.groups.map { group ->
            val zone = ZoneId.of(group.timezone)
            DynamicContainer.dynamicContainer(
                group.name,
                group.cases.map { case ->
                    DynamicTest.dynamicTest(case.name) {
                        val moment = ScheduleEvaluator.toLocalMoment(Instant.parse(case.nowUtc), zone)
                        val active = ScheduleEvaluator.resolveActivePlaylist(group.rules, group.defaultPlaylistId, moment)
                        assertEquals(case.expectedPlaylistId, active.playlistId, "${group.name} / ${case.name} at $moment")
                    }
                },
            )
        }

    @Test
    fun `the fixture is not empty`() {
        val count = file.groups.sumOf { it.cases.size }
        assertTrue(count >= 25, "expected the full set of schedule vectors, found $count")
    }
}
