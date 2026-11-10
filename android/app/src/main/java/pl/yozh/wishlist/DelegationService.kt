package pl.yozh.wishlist

/**
 * Через цей сервіс Chrome показує push-сповіщення Wishlist від імені
 * застосунку (з його іконкою й назвою) і питає дозвіл на них на Android 13+.
 * Уся логіка — в бібліотеці android-browser-helper; тут лише точка входу,
 * оголошена в маніфесті.
 */
class DelegationService : com.google.androidbrowserhelper.trusted.DelegationService()
